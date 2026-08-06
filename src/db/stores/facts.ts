import type { FxRates, ReserveFact, SupplyFact } from '../../domain/types.js';
import { FX_SCALE } from '../../domain/money.js';
import type { Queryable } from '../pool.js';
import {
  RESERVE_FACT_COLUMNS,
  SUPPLY_FACT_COLUMNS,
  toReserveFact,
  toSupplyFact,
  type ReserveFactRow,
  type SupplyFactRow,
} from '../rows.js';
import { fromBigInt, toBigInt, toDateParam } from '../types.js';

/**
 * Persistence for the append-only fact tables.
 *
 * Every store takes a `Queryable`, so a caller can hand it either the pool or a
 * transaction client: a custodian statement must land as one unit, and a
 * partially-applied statement would read as a real position change.
 */

/**
 * pg's `query<R>` constrains `R` to `QueryResultRow`, which is an index
 * signature. The frozen row interfaces deliberately have none, so widen here
 * rather than loosening the shared contract.
 */
type Queried<T> = T & Record<string, unknown>;

/** A reserve fact before the database assigns it an id. Corrections supersede, never edit. */
export type NewReserveFact = Omit<ReserveFact, 'id' | 'supersededBy'>;

export interface InsertResult {
  readonly inserted: ReserveFact[];
  /** Rows that hit `reserve_facts_dedupe_idx`, i.e. an already-ingested statement line. */
  readonly skipped: number;
}

const RESERVE_FACT_COLUMNS_F = RESERVE_FACT_COLUMNS.split(', ')
  .map((column) => `f.${column}`)
  .join(', ');

const RESERVE_FACT_INSERT_PARAMS = 12;

export interface InsertOptions {
  /**
   * The ingested document these lines came from.
   *
   * A batch property rather than a field on `ReserveFact`: which file delivered
   * a holding is provenance, and nothing in the reconciliation engine may read
   * it, so it stays out of the type the engine consumes.
   */
  readonly sourceDocumentId?: string;
}

/**
 * Postgres caps a statement at 65535 bind parameters. Exceeding it fails deep in
 * the wire protocol with a message that says nothing about batch size, so refuse
 * up front and make the caller chunk deliberately.
 */
const MAX_RESERVE_FACTS_PER_STATEMENT = Math.floor(65535 / RESERVE_FACT_INSERT_PARAMS);

export class PgReserveFactStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Insert a whole statement in one round trip.
   *
   * Re-ingesting a statement the connector already delivered is normal — SFTP
   * drops get replayed — so a duplicate line is silently skipped via the dedupe
   * index rather than treated as a new holding.
   */
  async insertMany(
    facts: readonly NewReserveFact[],
    options: InsertOptions = {},
  ): Promise<InsertResult> {
    if (facts.length === 0) return { inserted: [], skipped: 0 };

    if (facts.length > MAX_RESERVE_FACTS_PER_STATEMENT) {
      throw new RangeError(
        `cannot insert ${facts.length} reserve facts in one statement; ` +
          `the limit is ${MAX_RESERVE_FACTS_PER_STATEMENT}`,
      );
    }

    const params: unknown[] = [];
    const tuples: string[] = [];

    for (const fact of facts) {
      const base = params.length;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
          `$${base + 5}::instrument_category, $${base + 6}, $${base + 7}, ` +
          `$${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`,
      );
      params.push(
        fact.issuerId,
        fact.custodianId,
        fact.asOf,
        fact.observedAt,
        fact.instrumentCategory,
        fact.cusip,
        fact.currency,
        fromBigInt(fact.faceValueMinor),
        fromBigInt(fact.marketValueMinor),
        // Never a raw Date: the driver would serialize a DATE in the host's zone
        // and shift the maturity by a day west or east of UTC.
        toDateParam(fact.maturityDate),
        fact.sourceHash,
        options.sourceDocumentId ?? null,
      );
    }

    const { rows } = await this.db.query<Queried<ReserveFactRow>>(
      `INSERT INTO reserve_facts
         (issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip,
          currency, face_value_minor, market_value_minor, maturity_date, source_hash,
          source_document_id)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (custodian_id, as_of, instrument_category, COALESCE(cusip, ''),
                    face_value_minor, market_value_minor) DO NOTHING
       RETURNING ${RESERVE_FACT_COLUMNS}`,
      params,
    );

    const inserted = rows.map(toReserveFact);
    return { inserted, skipped: facts.length - inserted.length };
  }

  /**
   * The issuer's position at `asOf`: every line of each custodian's latest
   * statement at or before that instant.
   *
   * A statement is a complete snapshot, so this returns all rows sharing a
   * custodian's max `as_of` — not one row per custodian. Summing across
   * statement dates would double-count every holding.
   *
   * Must stay in exact agreement with `selectFactsAsOf` in
   * `src/domain/reconciliation.ts`; `test/db/facts.test.ts` proves it does.
   */
  async listCurrentAsOf(issuerId: string, asOf: Date): Promise<ReserveFact[]> {
    const { rows } = await this.db.query<Queried<ReserveFactRow>>(
      `SELECT ${RESERVE_FACT_COLUMNS_F}
         FROM reserve_facts f
         JOIN (SELECT custodian_id, MAX(as_of) AS latest
                 FROM reserve_facts
                WHERE issuer_id = $1 AND superseded_by IS NULL AND as_of <= $2
                GROUP BY custodian_id) l
           ON l.custodian_id = f.custodian_id AND l.latest = f.as_of
        WHERE f.issuer_id = $1 AND f.superseded_by IS NULL AND f.as_of <= $2
        ORDER BY f.id`,
      [issuerId, asOf],
    );
    return rows.map(toReserveFact);
  }

  /** Full history including superseded rows. For audit and lineage. */
  async listAllForIssuer(issuerId: string): Promise<ReserveFact[]> {
    const { rows } = await this.db.query<Queried<ReserveFactRow>>(
      `SELECT ${RESERVE_FACT_COLUMNS}
         FROM reserve_facts
        WHERE issuer_id = $1
        ORDER BY id`,
      [issuerId],
    );
    return rows.map(toReserveFact);
  }

  /**
   * Mark a fact superseded by its replacement. The only mutation the app role
   * holds on `reserve_facts` (see 002_grants.sql).
   *
   * `superseded_by IS NULL` is part of the predicate, not a prior read, so a
   * fact can be retracted exactly once. Two callers racing to retract the same
   * fact serialize on the row lock and the loser throws instead of silently
   * repointing the pointer — an unconditional UPDATE would let the last writer
   * win and erase the fact that the first correction ever existed. Retracting a
   * correction means superseding the correction, never rewriting the original.
   */
  async supersede(factId: string, replacementId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE reserve_facts SET superseded_by = $2
        WHERE id = $1 AND superseded_by IS NULL`,
      [factId, replacementId],
    );
    if (result.rowCount === 1) return;

    // Zero rows means the fact is absent or already retracted. Both are bugs but
    // they are different bugs, so name the right one. This read runs only on the
    // failure path, so it is not a read-then-write on the path that mutates.
    const { rows } = await this.db.query<Queried<{ superseded_by: string | null }>>(
      `SELECT superseded_by FROM reserve_facts WHERE id = $1`,
      [factId],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw new Error(`reserve fact ${factId} not found; nothing was superseded`);
    }
    throw new Error(
      `reserve fact ${factId} is already superseded by ${existing.superseded_by}; ` +
        'supersede the correction instead of rewriting the original',
    );
  }
}

/** A supply observation before the database assigns it an id. */
export type NewSupplyFact = Omit<SupplyFact, 'id'>;

/**
 * Two different total supplies observed at the same block.
 *
 * Signals a chain reorg or a faulty indexer. Requires an operator decision —
 * there is no safe automatic resolution, because either figure could be the
 * true one and the choice changes the collateralization ratio.
 */
export class ConflictingSupplyObservationError extends Error {
  constructor(
    readonly tokenDeploymentId: string,
    readonly blockNumber: bigint,
    readonly recorded: bigint,
    readonly incoming: bigint,
  ) {
    super(
      `conflicting supply for deployment ${tokenDeploymentId} at block ${blockNumber}: ` +
        `recorded ${recorded}, incoming ${incoming}`,
    );
    this.name = 'ConflictingSupplyObservationError';
  }
}

export class PgSupplyFactStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Record a supply observation. Returns null when this (deployment, block) was
   * already observed — chain indexers re-scan, and a re-scan is not new data.
   */
  async insert(fact: NewSupplyFact): Promise<SupplyFact | null> {
    const { rows } = await this.db.query<Queried<SupplyFactRow>>(
      `INSERT INTO supply_facts
         (token_deployment_id, block_number, block_timestamp, total_supply, observed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_deployment_id, block_number) DO NOTHING
       RETURNING ${SUPPLY_FACT_COLUMNS}`,
      [
        fact.tokenDeploymentId,
        fromBigInt(fact.blockNumber),
        fact.blockTimestamp,
        // NUMERIC(78,0): a uint256 does not survive BIGINT, let alone a JS number.
        fromBigInt(fact.totalSupply),
        fact.observedAt,
      ],
    );

    const row = rows[0];
    if (row !== undefined) return toSupplyFact(row);

    // The conflict was absorbed, so this block was already observed. A re-scan
    // reporting the SAME supply is ordinary and idempotent. A re-scan reporting a
    // DIFFERENT supply at the same block is not: it means a chain reorg replaced
    // history, or the indexer is wrong. Either way one of the two figures is
    // false, and outstanding supply is the denominator of the collateralization
    // ratio — silently keeping whichever landed first would put an unverifiable
    // number on a certified report.
    const existing = await this.findByBlock(fact.tokenDeploymentId, fact.blockNumber);
    if (existing !== null && existing.totalSupply !== fact.totalSupply) {
      throw new ConflictingSupplyObservationError(
        fact.tokenDeploymentId,
        fact.blockNumber,
        existing.totalSupply,
        fact.totalSupply,
      );
    }
    return null;
  }

  /** The observation recorded for a specific block, if any. */
  async findByBlock(tokenDeploymentId: string, blockNumber: bigint): Promise<SupplyFact | null> {
    const { rows } = await this.db.query<Queried<SupplyFactRow>>(
      `SELECT ${SUPPLY_FACT_COLUMNS} FROM supply_facts
        WHERE token_deployment_id = $1 AND block_number = $2`,
      [tokenDeploymentId, fromBigInt(blockNumber)],
    );
    const row = rows[0];
    return row === undefined ? null : toSupplyFact(row);
  }

  async listForIssuerAsOf(issuerId: string, asOf: Date): Promise<SupplyFact[]> {
    const { rows } = await this.db.query<Queried<SupplyFactRow>>(
      `SELECT ${SUPPLY_FACT_COLUMNS.split(', ')
        .map((column) => `s.${column}`)
        .join(', ')}
         FROM supply_facts s
         JOIN token_deployments d ON d.id = s.token_deployment_id
        WHERE d.issuer_id = $1 AND s.block_timestamp <= $2
        ORDER BY s.id`,
      [issuerId, asOf],
    );
    return rows.map(toSupplyFact);
  }
}

interface FxRateRow {
  currency: string;
  rate_to_usd: string;
}

export class PgFxRateStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Record observed rates. Rates are integers scaled by 1e8 so conversion never
   * touches floating point.
   *
   * An already-recorded (as_of, currency, source) is left untouched. This is
   * deliberately NOT an upsert, for two reasons:
   *
   *  1. Determinism. Regenerating a historical report must reproduce its original
   *     hash exactly. If a rate could be overwritten, a report recomputed after a
   *     vendor restatement would total differently and fail its own integrity
   *     check — breaking the one property the product rests on.
   *  2. Privilege. `fx_rates` is in the append-only set, so `reserveos_app` holds
   *     INSERT and SELECT but not UPDATE. Postgres checks UPDATE privilege at plan
   *     time, so an `ON CONFLICT DO UPDATE` here fails outright in production
   *     while passing every test, because the test harness connects as the owner.
   *
   * A genuine correction is recorded as a distinct `source` (e.g. `ECB` then
   * `ECB-RESTATED`), which keeps both observations and makes the substitution an
   * explicit, visible decision rather than a silent overwrite.
   */
  async recordMany(
    asOf: Date,
    source: string,
    ratesToUsd: ReadonlyMap<string, bigint>,
  ): Promise<void> {
    if (ratesToUsd.size === 0) return;

    const params: unknown[] = [];
    const tuples: string[] = [];

    for (const [currency, rate] of ratesToUsd) {
      const base = params.length;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      params.push(asOf, currency, fromBigInt(rate), source);
    }

    await this.db.query(
      `INSERT INTO fx_rates (as_of, currency, rate_to_usd, source)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (as_of, currency, source) DO NOTHING`,
      params,
    );
  }

  /**
   * The rate table in force at `asOf`: per currency, the most recent quote at or
   * before that instant. Rates are published irregularly, so a currency's latest
   * quote is frequently older than the period end.
   */
  async ratesAsOf(asOf: Date, source: string): Promise<FxRates> {
    const { rows } = await this.db.query<Queried<FxRateRow>>(
      `SELECT DISTINCT ON (currency) currency, rate_to_usd
         FROM fx_rates
        WHERE source = $2 AND as_of <= $1
        ORDER BY currency, as_of DESC`,
      [asOf, source],
    );

    const ratesToUsd = new Map<string, bigint>();
    for (const row of rows) {
      ratesToUsd.set(row.currency, toBigInt(row.rate_to_usd));
    }

    // USD is the unit of account: it must be present and it must be exactly 1.
    // A stored USD quote that disagrees is corrupt reference data, and quietly
    // preferring either value would misstate every USD holding.
    const storedUsd = ratesToUsd.get('USD');
    if (storedUsd !== undefined && storedUsd !== FX_SCALE) {
      throw new Error(
        `fx_rates holds a USD rate of ${storedUsd} for source ${source}; ` +
          `USD must be exactly ${FX_SCALE}`,
      );
    }
    ratesToUsd.set('USD', FX_SCALE);

    return { asOf, source, ratesToUsd };
  }
}
