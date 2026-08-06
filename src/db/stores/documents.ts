import type { Queryable } from '../pool.js';
import { toBigInt } from '../types.js';

/**
 * Ingested source documents.
 *
 * The evidentiary point of this table: when a figure on a certified report is
 * questioned months later, the exact bytes it came from must still be
 * identifiable. `reserve_facts.source_document_id` points here, so every holding
 * traces back to a named file and its content hash.
 */

export type SourceDocumentStatus = 'INGESTED' | 'REJECTED' | 'SUPERSEDED';

export interface SourceDocument {
  readonly id: string;
  readonly issuerId: string;
  readonly custodianId: string | null;
  readonly filename: string;
  readonly contentHash: string;
  readonly byteSize: bigint;
  readonly statementAsOf: Date | null;
  readonly rowCount: number | null;
  readonly status: SourceDocumentStatus;
  readonly rejectionReason: string | null;
  readonly ingestedAt: Date;
}

export interface NewSourceDocument {
  readonly issuerId: string;
  readonly custodianId: string | null;
  readonly filename: string;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly statementAsOf?: Date | null;
  readonly rowCount?: number | null;
  readonly status?: SourceDocumentStatus;
  readonly rejectionReason?: string | null;
}

interface SourceDocumentRow {
  id: string;
  issuer_id: string;
  custodian_id: string | null;
  filename: string;
  content_hash: string;
  byte_size: string;
  statement_as_of: Date | null;
  row_count: number | null;
  status: SourceDocumentStatus;
  rejection_reason: string | null;
  ingested_at: Date;
}

const COLUMNS =
  'id, issuer_id, custodian_id, filename, content_hash, byte_size, statement_as_of, ' +
  'row_count, status, rejection_reason, ingested_at';

function toSourceDocument(row: SourceDocumentRow): SourceDocument {
  return {
    id: row.id,
    issuerId: row.issuer_id,
    custodianId: row.custodian_id,
    filename: row.filename,
    contentHash: row.content_hash,
    byteSize: toBigInt(row.byte_size),
    statementAsOf: row.statement_as_of,
    rowCount: row.row_count,
    status: row.status,
    rejectionReason: row.rejection_reason,
    ingestedAt: row.ingested_at,
  };
}

export class PgSourceDocumentStore {
  constructor(private readonly db: Queryable) {}

  async insert(document: NewSourceDocument): Promise<SourceDocument> {
    const { rows } = await this.db.query<SourceDocumentRow>(
      `INSERT INTO source_documents
         (issuer_id, custodian_id, filename, content_hash, byte_size,
          statement_as_of, row_count, status, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::source_document_status, $9)
       RETURNING ${COLUMNS}`,
      [
        document.issuerId,
        document.custodianId,
        document.filename,
        document.contentHash,
        String(document.byteSize),
        document.statementAsOf ?? null,
        document.rowCount ?? null,
        document.status ?? 'INGESTED',
        document.rejectionReason ?? null,
      ],
    );
    return toSourceDocument(rows[0]!);
  }

  /** Locate a previously-ingested document by its content hash. */
  async findByContentHash(issuerId: string, contentHash: string): Promise<SourceDocument | null> {
    const { rows } = await this.db.query<SourceDocumentRow>(
      `SELECT ${COLUMNS} FROM source_documents WHERE issuer_id = $1 AND content_hash = $2`,
      [issuerId, contentHash],
    );
    const row = rows[0];
    return row === undefined ? null : toSourceDocument(row);
  }

  async listForIssuer(issuerId: string): Promise<SourceDocument[]> {
    const { rows } = await this.db.query<SourceDocumentRow>(
      `SELECT ${COLUMNS} FROM source_documents
        WHERE issuer_id = $1 ORDER BY ingested_at DESC, id`,
      [issuerId],
    );
    return rows.map(toSourceDocument);
  }

  /** The document a given fact came from, for lineage queries. */
  async findForFact(factId: string): Promise<SourceDocument | null> {
    const { rows } = await this.db.query<SourceDocumentRow>(
      `SELECT ${COLUMNS.split(', ')
        .map((c) => `d.${c}`)
        .join(', ')}
         FROM source_documents d
         JOIN reserve_facts f ON f.source_document_id = d.id
        WHERE f.id = $1`,
      [factId],
    );
    const row = rows[0];
    return row === undefined ? null : toSourceDocument(row);
  }
}
