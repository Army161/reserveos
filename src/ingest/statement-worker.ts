import type pg from 'pg';
import { createHash } from 'node:crypto';
import { withTenant } from '../db/pool.js';
import { PgReserveFactStore, type NewReserveFact } from '../db/stores/facts.js';
import { PgSourceDocumentStore } from '../db/stores/documents.js';
import { CsvParseError, parseCsvTable, type CsvRow, type CsvTable } from './csv.js';
import {
  mapStatementLine,
  parseStatementDate,
  ValueParseError,
  type StatementMapping,
} from './mapping.js';
import { contentHash, type StatementFile, type StatementSource } from './source.js';

/**
 * The custodian statement ingestion worker.
 *
 * Chains the pieces into one transactional unit: fetch -> hash -> parse -> map ->
 * persist. The whole file lands or none of it does, because a half-applied
 * statement looks to the reconciliation engine like a genuine change in
 * position, which would silently misstate reserves.
 */

/** How to determine the statement's effective date. */
export type StatementDateResolver =
  | { readonly kind: 'column'; readonly column: string }
  | { readonly kind: 'filename'; readonly pattern: RegExp }
  | { readonly kind: 'fixed'; readonly value: Date };

export interface CustodianFeed {
  readonly issuerId: string;
  readonly custodianId: string;
  readonly source: StatementSource;
  readonly mapping: StatementMapping;
  readonly statementDate: StatementDateResolver;
}

export type IngestionStatus = 'INGESTED' | 'DUPLICATE' | 'REJECTED';

export interface IngestionOutcome {
  readonly filename: string;
  readonly status: IngestionStatus;
  readonly documentId: string | null;
  readonly factsInserted: number;
  readonly factsSkipped: number;
  readonly statementAsOf: Date | null;
  readonly error: string | null;
}

export interface StatementWorkerOptions {
  readonly pool: pg.Pool;
  /** Injected so ingestion timestamps are controllable in tests. */
  readonly now: () => Date;
}

/**
 * Field delimiter for the provenance hash.
 *
 * NUL cannot appear in a field produced by the CSV parser, so joining on it
 * makes the hash injective: `['a','bc']` and `['ab','c']` cannot collide.
 *
 * Written as an escape rather than a literal control character in the source.
 * A raw NUL makes the file binary to git, grep and diff, so the delimiter would
 * be invisible in review — and any tool that stripped or normalised it would
 * silently change every provenance hash ever computed, including those already
 * anchored on chain.
 */
const FIELD_DELIMITER = '\u0000';

/**
 * Per-line provenance hash.
 *
 * Covers the raw field values exactly as delivered by the custodian.
 */
export function lineHash(fields: readonly string[]): string {
  return createHash('sha256').update(fields.join(FIELD_DELIMITER), 'utf8').digest('hex');
}

export class StatementIngestionWorker {
  constructor(private readonly options: StatementWorkerOptions) {}

  /** Process every pending file on a feed, oldest first. */
  async run(feed: CustodianFeed): Promise<IngestionOutcome[]> {
    const files = await feed.source.list();
    const outcomes: IngestionOutcome[] = [];
    for (const file of files) {
      outcomes.push(await this.ingestFile(feed, file));
    }
    return outcomes;
  }

  async ingestFile(feed: CustodianFeed, file: StatementFile): Promise<IngestionOutcome> {
    const bytes = await feed.source.read(file);
    const hash = contentHash(bytes);

    // Identical bytes already ingested: an SFTP replay, not new data. Checked
    // before parsing so a redelivery costs nothing.
    const existing = await withTenant(this.options.pool, feed.issuerId, (client) =>
      new PgSourceDocumentStore(client).findByContentHash(feed.issuerId, hash),
    );
    if (existing !== null) {
      await feed.source.markProcessed(file);
      return {
        filename: file.name,
        status: 'DUPLICATE',
        documentId: existing.id,
        factsInserted: 0,
        factsSkipped: 0,
        statementAsOf: existing.statementAsOf,
        error: null,
      };
    }

    let table: CsvTable;
    let statementAsOf: Date;
    let facts: NewReserveFact[];

    try {
      table = parseCsvTable(bytes.toString('utf8'));
      statementAsOf = resolveStatementDate(feed, file, table);
      facts = this.buildFacts(feed, table, statementAsOf);
    } catch (error) {
      return this.reject(feed, file, hash, bytes.length, error);
    }

    try {
      // `withTenant` rather than a bare transaction: in production the worker
      // connects as `reserveos_app`, which is subject to row-level security, so
      // without the tenant setting every write would be filtered out and the
      // statement would silently vanish.
      return await withTenant(this.options.pool, feed.issuerId, async (client) => {
        const document = await new PgSourceDocumentStore(client).insert({
          issuerId: feed.issuerId,
          custodianId: feed.custodianId,
          filename: file.name,
          contentHash: hash,
          byteSize: bytes.length,
          statementAsOf,
          rowCount: table.rows.length,
          status: 'INGESTED',
        });

        const result = await new PgReserveFactStore(client).insertMany(facts, {
          sourceDocumentId: document.id,
        });

        return {
          filename: file.name,
          status: 'INGESTED' as const,
          documentId: document.id,
          factsInserted: result.inserted.length,
          factsSkipped: result.skipped,
          statementAsOf,
          error: null,
        };
      }).then(async (outcome) => {
        // Only after the commit: a crash before this leaves the file pending and
        // the next run dedupes on content hash, so replay is safe either way.
        await feed.source.markProcessed(file);
        return outcome;
      });
    } catch (error) {
      return this.reject(feed, file, hash, bytes.length, error);
    }
  }

  private buildFacts(
    feed: CustodianFeed,
    table: CsvTable,
    statementAsOf: Date,
  ): NewReserveFact[] {
    const observedAt = this.options.now();

    return table.rows.map((row) => {
      const fields = toFieldRecord(table, row);
      let line;
      try {
        line = mapStatementLine(fields, feed.mapping);
      } catch (error) {
        // Attach the physical line so an operator can open the file and look.
        if (error instanceof ValueParseError) {
          throw new StatementRowError(row.lineNumber, error.message, error);
        }
        throw error;
      }

      return {
        issuerId: feed.issuerId,
        custodianId: feed.custodianId,
        asOf: statementAsOf,
        observedAt,
        instrumentCategory: line.instrumentCategory,
        cusip: line.cusip,
        currency: line.currency,
        faceValueMinor: line.faceValueMinor,
        marketValueMinor: line.marketValueMinor,
        maturityDate: line.maturityDate,
        sourceHash: lineHash(row.raw),
      };
    });
  }

  /** Record the failure, quarantine the file, and keep the run going. */
  private async reject(
    feed: CustodianFeed,
    file: StatementFile,
    hash: string,
    byteSize: number,
    error: unknown,
  ): Promise<IngestionOutcome> {
    const reason = error instanceof Error ? error.message : String(error);

    const document = await withTenant(this.options.pool, feed.issuerId, (client) =>
      new PgSourceDocumentStore(client).insert({
        issuerId: feed.issuerId,
        custodianId: feed.custodianId,
        filename: file.name,
        contentHash: hash,
        byteSize,
        status: 'REJECTED',
        rejectionReason: reason,
      }),
    );

    await feed.source.markFailed(file, reason);

    return {
      filename: file.name,
      status: 'REJECTED',
      documentId: document.id,
      factsInserted: 0,
      factsSkipped: 0,
      statementAsOf: null,
      error: reason,
    };
  }
}

/** A row that could not be mapped, carrying its line number. */
export class StatementRowError extends Error {
  constructor(
    readonly lineNumber: number,
    detail: string,
    override readonly cause: Error,
  ) {
    super(`line ${lineNumber}: ${detail}`);
    this.name = 'StatementRowError';
  }
}

function toFieldRecord(table: CsvTable, row: CsvRow): Record<string, string> {
  // A null-prototype object: header names come from an external file, and a
  // column called `constructor` or `__proto__` must be data, not a prototype
  // lookup or an assignment that mutates Object.prototype.
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [index, header] of table.headers.entries()) {
    fields[header] = row.raw[index]!;
  }
  return fields;
}

function resolveStatementDate(
  feed: CustodianFeed,
  file: StatementFile,
  table: CsvTable,
): Date {
  const resolver = feed.statementDate;

  if (resolver.kind === 'fixed') return resolver.value;

  if (resolver.kind === 'filename') {
    const match = resolver.pattern.exec(file.name);
    const captured = match?.[1];
    if (captured === undefined) {
      throw new Error(
        `cannot read a statement date from filename ${JSON.stringify(file.name)} ` +
          `using ${resolver.pattern}`,
      );
    }
    return parseStatementDate(captured, feed.mapping.dateFormat, 'statementDate');
  }

  if (table.rows.length === 0) {
    throw new Error(`statement has no rows, so ${resolver.column} cannot supply its date`);
  }

  // Every row must agree. A statement carrying two effective dates is not one
  // position snapshot, and picking either would silently drop half the holdings
  // during latest-statement selection.
  const seen = new Set<string>();
  let first: Date | undefined;
  for (const row of table.rows) {
    const parsed = parseStatementDate(
      row.get(resolver.column),
      feed.mapping.dateFormat,
      resolver.column,
    );
    seen.add(parsed.toISOString());
    first ??= parsed;
    if (seen.size > 1) {
      throw new Error(
        `statement mixes effective dates (${[...seen].sort().join(', ')}); ` +
          'a statement must be a single position snapshot',
      );
    }
  }

  return first!;
}

export { CsvParseError, ValueParseError };
