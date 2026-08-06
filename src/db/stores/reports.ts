import type { Queryable } from '../pool.js';
import { toDateParam } from '../types.js';

/**
 * Reporting-period and report-version store.
 *
 * `report_versions` is append-only and its payload hash is what gets signed and
 * anchored on chain. Version numbers are therefore part of the evidentiary
 * record: two rows claiming to be "version 2" of the same period would make the
 * approval chain ambiguous, which is why allocation happens inside the INSERT
 * rather than in application code.
 */

export type PeriodStatus = 'OPEN' | 'IN_REVIEW' | 'CERTIFIED' | 'PUBLISHED';

export interface ReportingPeriod {
  id: string;
  issuerId: string;
  periodStart: Date;
  periodEnd: Date;
  status: PeriodStatus;
  createdAt: Date;
}

export interface ReportVersion {
  id: string;
  periodId: string;
  version: number;
  payload: unknown;
  payloadHash: string;
  generatedAt: Date;
  generatedBy: string;
}

export interface InsertReportVersionParams {
  readonly periodId: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly generatedAt: Date;
  readonly generatedBy: string;
}

const PERIOD_COLUMNS = 'id, issuer_id, period_start, period_end, status, created_at';

const VERSION_COLUMNS =
  'id, period_id, version, payload, payload_hash, generated_at, generated_by';

interface ReportingPeriodRow {
  id: string;
  issuer_id: string;
  period_start: Date;
  period_end: Date;
  status: string;
  created_at: Date;
}

interface ReportVersionRow {
  id: string;
  period_id: string;
  version: number;
  payload: unknown;
  payload_hash: string;
  generated_at: Date;
  generated_by: string;
}

/**
 * Allocating `version` from `MAX(version) + 1` inside one statement is atomic
 * per statement but not serializable: two concurrent generators can both read
 * the same maximum under READ COMMITTED and race to insert the same number.
 * UNIQUE (period_id, version) turns that race into a rejected insert rather than
 * a duplicate, and the loser simply re-reads and tries the next number. Each
 * round guarantees at least one winner, so N contenders converge in at most N
 * rounds; the bound below is a livelock guard, not a tuning knob.
 *
 * NOTE: this retry only works when `db` is a pool (each query is its own implicit
 * transaction). Inside an explicit transaction a unique violation aborts the
 * whole transaction, so the caller must retry the transaction instead.
 */
const MAX_VERSION_ATTEMPTS = 25;

/** Auto-generated name for UNIQUE (period_id, version) in 001_init.sql. */
const VERSION_UNIQUE_CONSTRAINT = 'report_versions_period_id_version_key';

/**
 * `payload_hash` is SHA-256 over RFC 8785 canonical JSON, rendered by
 * `canonicalHash()` as 64 lowercase hex characters.
 *
 * The column is CHAR(64), which blank-pads anything shorter *without warning*:
 * writing 'deadbeef' stores 'deadbeef' followed by 56 spaces and reads back a
 * string that is no longer `===` the one the caller hashed. Nothing downstream
 * would notice — `findByHash` still matches it, because bpchar comparison
 * ignores trailing blanks — but `certification.ts` feeds this value straight
 * into `merkleRoot` for anchoring, and `PgAnchorStore`'s own length check passes
 * happily on the padded 64-character result. The chain would then carry a
 * commitment to a string of spaces, and every future examiner verification of
 * that report would fail with no way to tell mis-storage from tampering.
 *
 * So the format is enforced on the way in and re-checked on the way out.
 */
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

function requirePayloadHash(value: unknown, context: string): string {
  if (typeof value !== 'string' || !PAYLOAD_HASH_PATTERN.test(value)) {
    throw new TypeError(
      `${context} must be 64 lowercase hex characters (SHA-256), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const INSERT_VERSION_SQL = `
  INSERT INTO report_versions
    (period_id, version, payload, payload_hash, generated_at, generated_by)
  SELECT $1::UUID, COALESCE(MAX(version), 0) + 1, $2::JSONB, $3, $4::TIMESTAMPTZ, $5::UUID
  FROM report_versions
  WHERE period_id = $1::UUID
  RETURNING ${VERSION_COLUMNS}
`;

export class PgReportStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Open a reporting period, or return the existing one.
   *
   * Period creation is driven by a scheduler that may fire more than once for
   * the same calendar period; a duplicate run must be a no-op, not an error.
   */
  async openPeriod(
    issuerId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<ReportingPeriod> {
    const inserted = await this.db.query(
      `INSERT INTO reporting_periods (issuer_id, period_start, period_end)
       VALUES ($1, $2, $3)
       ON CONFLICT (issuer_id, period_end) DO NOTHING
       RETURNING ${PERIOD_COLUMNS}`,
      [issuerId, toDateParam(periodStart), toDateParam(periodEnd)],
    );
    const row = (inserted.rows as ReportingPeriodRow[])[0];
    if (row !== undefined) return toReportingPeriod(row);

    const existing = await this.findPeriod(issuerId, periodEnd);
    if (existing === null) {
      // The insert conflicted, so a row exists; not finding it means the unique
      // key we conflicted on is not the one we searched by.
      throw new Error(
        `reporting period for issuer ${issuerId} ending ${String(toDateParam(periodEnd))} ` +
          'conflicted on insert but could not be read back',
      );
    }

    // The unique key is (issuer_id, period_end) alone, so a caller asking for a
    // *different* start against the same end silently gets the stored window
    // back. Idempotency means "the same period twice", not "any period sharing
    // an end date": a report covering 01-15..03-31 that quietly becomes
    // 03-01..03-31 is a wrong statutory window, so disagreement is an error.
    const requestedStart = toDateParam(periodStart);
    const storedStart = toDateParam(existing.periodStart);
    if (requestedStart !== storedStart) {
      throw new Error(
        `reporting period for issuer ${issuerId} ending ${String(toDateParam(periodEnd))} ` +
          `already exists starting ${String(storedStart)}, not ${String(requestedStart)}`,
      );
    }
    return existing;
  }

  async getPeriod(id: string): Promise<ReportingPeriod | null> {
    const result = await this.db.query(
      `SELECT ${PERIOD_COLUMNS} FROM reporting_periods WHERE id = $1`,
      [id],
    );
    const row = (result.rows as ReportingPeriodRow[])[0];
    return row === undefined ? null : toReportingPeriod(row);
  }

  async findPeriod(issuerId: string, periodEnd: Date): Promise<ReportingPeriod | null> {
    const result = await this.db.query(
      `SELECT ${PERIOD_COLUMNS} FROM reporting_periods
       WHERE issuer_id = $1 AND period_end = $2`,
      [issuerId, toDateParam(periodEnd)],
    );
    const row = (result.rows as ReportingPeriodRow[])[0];
    return row === undefined ? null : toReportingPeriod(row);
  }

  async setPeriodStatus(id: string, status: PeriodStatus): Promise<void> {
    const result = await this.db.query(
      'UPDATE reporting_periods SET status = $2::period_status WHERE id = $1',
      [id, status],
    );
    if (result.rowCount !== 1) {
      throw new Error(`reporting period ${id} does not exist`);
    }
  }

  async insertVersion(params: InsertReportVersionParams): Promise<ReportVersion> {
    const values = [
      params.periodId,
      JSON.stringify(params.payload),
      requirePayloadHash(params.payloadHash, 'payload_hash'),
      params.generatedAt,
      params.generatedBy,
    ];

    for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt += 1) {
      try {
        // Each attempt is wrapped in a savepoint. Without one, a caller that is
        // already inside a transaction — which every API request is — would have
        // that transaction aborted by the first constraint violation, and both
        // this retry and any recovery the caller attempts would fail with 25P02.
        // The retry only ever worked when called in autocommit mode.
        return await this.withSavepoint(`report_version_${attempt}`, async () => {
          const result = await this.db.query(INSERT_VERSION_SQL, values);
          const row = (result.rows as ReportVersionRow[])[0];
          if (row === undefined) {
            throw new Error(
              `insert of a report version for period ${params.periodId} returned no row`,
            );
          }
          return toReportVersion(row);
        });
      } catch (error) {
        if (!isVersionCollision(error)) throw error;
        // Jitter so a burst of generators does not re-collide in lockstep.
        await sleep(Math.floor(Math.random() * 5));
      }
    }

    throw new Error(
      `could not allocate a report version for period ${params.periodId} ` +
        `after ${MAX_VERSION_ATTEMPTS} attempts`,
    );
  }

  async listVersions(periodId: string): Promise<ReportVersion[]> {
    const result = await this.db.query(
      `SELECT ${VERSION_COLUMNS} FROM report_versions WHERE period_id = $1 ORDER BY version`,
      [periodId],
    );
    return (result.rows as ReportVersionRow[]).map(toReportVersion);
  }

  async getLatestVersion(periodId: string): Promise<ReportVersion | null> {
    const result = await this.db.query(
      `SELECT ${VERSION_COLUMNS} FROM report_versions
       WHERE period_id = $1 ORDER BY version DESC LIMIT 1`,
      [periodId],
    );
    const row = (result.rows as ReportVersionRow[])[0];
    return row === undefined ? null : toReportVersion(row);
  }

  /**
   * Run `fn` inside a savepoint when a transaction is open.
   *
   * Outside a transaction each statement commits on its own, so a failure
   * poisons nothing and no savepoint is needed — Postgres rejects SAVEPOINT
   * there with 25P01, which is the signal we act on.
   */
  private async withSavepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
    let active = false;
    try {
      await this.db.query(`SAVEPOINT ${name}`);
      active = true;
    } catch (error) {
      if ((error as { code?: string }).code !== '25P01') throw error;
    }

    try {
      const result = await fn();
      if (active) await this.db.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      if (active) await this.db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  async getVersion(id: string): Promise<ReportVersion | null> {
    const result = await this.db.query(
      `SELECT ${VERSION_COLUMNS} FROM report_versions WHERE id = $1`,
      [id],
    );
    const row = (result.rows as ReportVersionRow[])[0];
    return row === undefined ? null : toReportVersion(row);
  }

  /** Examiner entry point: locate a version from the hash printed on the report. */
  async findByHash(payloadHash: string): Promise<ReportVersion | null> {
    const result = await this.db.query(
      `SELECT ${VERSION_COLUMNS} FROM report_versions WHERE payload_hash = $1`,
      [payloadHash],
    );
    const row = (result.rows as ReportVersionRow[])[0];
    return row === undefined ? null : toReportVersion(row);
  }
}

function isVersionCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === VERSION_UNIQUE_CONSTRAINT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const PERIOD_STATUSES: readonly string[] = ['OPEN', 'IN_REVIEW', 'CERTIFIED', 'PUBLISHED'];

function toReportingPeriod(row: ReportingPeriodRow): ReportingPeriod {
  if (!PERIOD_STATUSES.includes(row.status)) {
    throw new TypeError(`unknown period status: ${row.status}`);
  }
  return {
    id: row.id,
    issuerId: row.issuer_id,
    periodStart: requireDate(row.period_start, 'period_start'),
    periodEnd: requireDate(row.period_end, 'period_end'),
    status: row.status as PeriodStatus,
    createdAt: requireDate(row.created_at, 'created_at'),
  };
}

function toReportVersion(row: ReportVersionRow): ReportVersion {
  if (!Number.isSafeInteger(row.version) || row.version < 1) {
    throw new TypeError(`column version is not a positive integer: ${String(row.version)}`);
  }
  return {
    id: row.id,
    periodId: row.period_id,
    version: row.version,
    payload: row.payload,
    // Catches rows blank-padded by a writer that bypassed `insertVersion`.
    // Handing an examiner a padded commitment is the failure this guards.
    payloadHash: requirePayloadHash(row.payload_hash, `report version ${row.id} payload_hash`),
    generatedAt: requireDate(row.generated_at, 'generated_at'),
    generatedBy: row.generated_by,
  };
}

function requireDate(value: unknown, column: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`column ${column} is not a valid timestamp: ${String(value)}`);
  }
  return value;
}
