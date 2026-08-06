import type { AnchorSubjectType } from '../../kaleido/client.js';
import {
  APPROVAL_ROLES,
  CertificationError,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApprovalRole,
  type ApprovalStore,
} from '../../services/certification.js';
import type { AnchorRecord, AnchorStore } from '../../services/evidence.js';
import type { RedemptionRequest, RedemptionStatus } from '../../services/redemption.js';
import type { Queryable } from '../pool.js';
import { fromBigInt, toBigInt, toBigIntOrNull } from '../types.js';

/**
 * Postgres implementations of the workflow stores.
 *
 * These are drop-in replacements for the in-memory stores the services are
 * developed against, so the observable behaviour — including which operations
 * throw — has to match. Where the database can enforce an invariant (one anchor
 * per subject, one decision per role per version) the constraint is the source
 * of truth and the store translates the violation back into the error the
 * service layer already knows how to handle.
 */

const UNIQUE_VIOLATION = '23505';

const ANCHOR_SUBJECTS = ['DAILY_ROLLUP', 'REPORT_VERSION', 'APPROVAL'] as const;
const ANCHOR_STATUSES = ['PENDING', 'CONFIRMED', 'FAILED'] as const;
const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
const REDEMPTION_STATUSES = [
  'RECEIVED',
  'PROCESSING',
  'SETTLED',
  'REJECTED',
  'BREACHED',
] as const;

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

interface AnchorRow {
  id: string;
  issuer_id: string;
  subject_type: string;
  subject_id: string;
  merkle_root: string;
  kaleido_operation_id: string | null;
  besu_tx_hash: string | null;
  besu_block_number: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
}

const ANCHOR_COLUMNS =
  'id, issuer_id, subject_type, subject_id, merkle_root, kaleido_operation_id, ' +
  'besu_tx_hash, besu_block_number, status, attempts, last_error';

function toAnchorRecord(row: AnchorRow): AnchorRecord {
  return {
    id: row.id,
    issuerId: row.issuer_id,
    subjectType: requireMember<AnchorSubjectType>(row.subject_type, ANCHOR_SUBJECTS, 'subject_type'),
    subjectId: row.subject_id,
    merkleRoot: requireMerkleRoot(row.merkle_root, 'column merkle_root'),
    operationId: row.kaleido_operation_id,
    transactionHash: row.besu_tx_hash,
    blockNumber: toBigIntOrNull(row.besu_block_number),
    status: requireMember<AnchorRecord['status']>(row.status, ANCHOR_STATUSES, 'status'),
    attempts: requireInteger(row.attempts, 'attempts'),
    lastError: row.last_error,
  };
}

export class PgAnchorStore implements AnchorStore {
  constructor(private readonly db: Queryable) {}

  async find(subjectType: AnchorSubjectType, subjectId: string): Promise<AnchorRecord | null> {
    const { rows } = await this.db.query<AnchorRow>(
      `SELECT ${ANCHOR_COLUMNS} FROM anchors
        WHERE subject_type = $1::anchor_subject AND subject_id = $2`,
      [subjectType, subjectId],
    );
    const row = rows[0];
    return row === undefined ? null : toAnchorRecord(row);
  }

  async insert(record: AnchorRecord): Promise<void> {
    requireMerkleRoot(record.merkleRoot, 'merkle root');

    try {
      await this.db.query(
        `INSERT INTO anchors
           (id, issuer_id, subject_type, subject_id, merkle_root, kaleido_operation_id,
            besu_tx_hash, besu_block_number, status, attempts, last_error, anchored_at)
         VALUES ($1, $2, $3::anchor_subject, $4, $5, $6, $7, $8, $9::anchor_status, $10, $11,
                 CASE WHEN $9::anchor_status = 'CONFIRMED' THEN now() END)`,
        [
          record.id,
          record.issuerId,
          record.subjectType,
          record.subjectId,
          record.merkleRoot,
          record.operationId,
          record.transactionHash,
          record.blockNumber === null ? null : fromBigInt(record.blockNumber),
          record.status,
          record.attempts,
          record.lastError,
        ],
      );
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint !== null && constraint !== 'anchors_pkey') {
        throw new Error(`duplicate anchor ${record.subjectType}:${record.subjectId}`);
      }
      throw error;
    }
  }

  async update(record: AnchorRecord): Promise<void> {
    const result = await this.db.query(
      `UPDATE anchors
          SET kaleido_operation_id = $2,
              besu_tx_hash         = $3,
              besu_block_number    = $4,
              status               = $5::anchor_status,
              attempts             = $6,
              last_error           = $7,
              -- First confirmation wins; a later sweep must not restamp it.
              anchored_at = CASE
                WHEN $5::anchor_status = 'CONFIRMED' THEN COALESCE(anchored_at, now())
                ELSE anchored_at
              END
        -- CONFIRMED is terminal. Concurrent sweeps can hold a stale in-memory
        -- record, and without this guard the later writer regresses a confirmed
        -- anchor back to PENDING — leaving a row stamped anchored_at but marked
        -- unconfirmed, and prompting a pointless re-submission of a commitment
        -- that is already on chain. A transaction cannot leave the ledger.
        WHERE id = $1 AND status <> 'CONFIRMED'`,
      [
        record.id,
        record.operationId,
        record.transactionHash,
        record.blockNumber === null ? null : fromBigInt(record.blockNumber),
        record.status,
        record.attempts,
        record.lastError,
      ],
    );

    if (result.rowCount === 1) return;

    // No row updated: either the anchor is already CONFIRMED (the guard above
    // fired, which is a legitimate no-op) or it does not exist. Losing a status
    // transition silently would strand an anchor as PENDING forever, so the
    // second case must still be an error.
    const { rows } = await this.db.query<{ status: AnchorRecord['status'] }>(
      'SELECT status FROM anchors WHERE id = $1',
      [record.id],
    );
    if (rows[0]?.status === 'CONFIRMED') return;
    throw new Error(`anchor ${record.id} does not exist`);
  }

  async listPending(): Promise<AnchorRecord[]> {
    const { rows } = await this.db.query<AnchorRow>(
      `SELECT ${ANCHOR_COLUMNS} FROM anchors
        WHERE status = 'PENDING'
        ORDER BY created_at, id`,
    );
    return rows.map(toAnchorRecord);
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  report_version_id: string;
  role: string;
  actor_id: string;
  actor_email: string;
  decision: string;
  attestation_text: string;
  signature: string;
  signed_at: Date;
  pms_decision_id: string | null;
}

const APPROVAL_COLUMNS =
  'id, report_version_id, role, actor_id, actor_email, decision, attestation_text, ' +
  'signature, signed_at, pms_decision_id';

function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  // The column is nullable for historical reasons, but an approval without a
  // Policy Manager decision id has no independent record of the authorization.
  if (row.pms_decision_id === null) {
    throw new TypeError(`approval ${row.id} has no pms_decision_id`);
  }

  return {
    id: row.id,
    reportVersionId: row.report_version_id,
    role: requireMember<ApprovalRole>(row.role, APPROVAL_ROLES, 'role'),
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    decision: requireMember<ApprovalDecision>(row.decision, APPROVAL_DECISIONS, 'decision'),
    attestationText: row.attestation_text,
    signature: row.signature,
    signedAt: requireDate(row.signed_at, 'signed_at'),
    pmsDecisionId: row.pms_decision_id,
  };
}

export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly db: Queryable) {}

  async listForVersion(reportVersionId: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.db.query<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE report_version_id = $1
        ORDER BY signed_at, id`,
      [reportVersionId],
    );
    return rows.map(toApprovalRecord);
  }

  async insert(record: ApprovalRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO approvals
           (id, report_version_id, role, actor_id, actor_email, decision,
            attestation_text, signature, signed_at, pms_decision_id)
         VALUES ($1, $2, $3::approval_role, $4, $5, $6::approval_decision, $7, $8, $9, $10)`,
        [
          record.id,
          record.reportVersionId,
          record.role,
          record.actorId,
          record.actorEmail,
          record.decision,
          record.attestationText,
          record.signature,
          record.signedAt,
          record.pmsDecisionId,
        ],
      );
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === null || constraint === 'approvals_pkey') throw error;

      // The two constraints mean different things and an operator has to be able
      // to tell them apart: one says the stage is taken, the other says the
      // person is. Reporting the four-eyes violation as "CFO has already decided"
      // would send someone looking for a signature that does not exist.
      if (constraint === 'approvals_one_decision_per_actor') {
        throw new CertificationError(
          `${record.actorEmail} already recorded a decision on this version; ` +
            `${record.role} must be a different person`,
        );
      }
      throw new CertificationError(`${record.role} has already decided on this version`);
    }
  }
}

// ---------------------------------------------------------------------------
// Redemption requests
// ---------------------------------------------------------------------------

interface RedemptionRow {
  id: string;
  issuer_id: string;
  external_ref: string;
  requested_at: Date;
  amount_minor: string;
  sla_deadline: Date;
  settled_at: Date | null;
  status: string;
}

const REDEMPTION_COLUMNS =
  'id, issuer_id, external_ref, requested_at, amount_minor, sla_deadline, settled_at, status';

function toRedemptionRequest(row: RedemptionRow): RedemptionRequest {
  return {
    id: row.id,
    issuerId: row.issuer_id,
    externalRef: row.external_ref,
    requestedAt: requireDate(row.requested_at, 'requested_at'),
    amountMinor: toBigInt(row.amount_minor),
    slaDeadline: requireDate(row.sla_deadline, 'sla_deadline'),
    settledAt: row.settled_at === null ? null : requireDate(row.settled_at, 'settled_at'),
    status: requireMember<RedemptionStatus>(row.status, REDEMPTION_STATUSES, 'status'),
  };
}

export class PgRedemptionStore {
  constructor(private readonly db: Queryable) {}

  async insert(request: RedemptionRequest): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO redemption_requests
           (id, issuer_id, external_ref, requested_at, amount_minor, sla_deadline,
            settled_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::redemption_status)`,
        [
          request.id,
          request.issuerId,
          request.externalRef,
          request.requestedAt,
          fromBigInt(request.amountMinor),
          request.slaDeadline,
          request.settledAt,
          request.status,
        ],
      );
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint !== null && constraint !== 'redemption_requests_pkey') {
        throw new Error(
          `duplicate redemption request ${request.externalRef} for issuer ${request.issuerId}`,
        );
      }
      throw error;
    }
  }

  async update(request: RedemptionRequest): Promise<void> {
    const result = await this.db.query(
      `UPDATE redemption_requests
          SET settled_at = $2, status = $3::redemption_status
        WHERE id = $1`,
      [request.id, request.settledAt, request.status],
    );

    if (result.rowCount !== 1) {
      throw new Error(`redemption request ${request.id} does not exist`);
    }
  }

  /** Requests made within [start, end], both ends inclusive. */
  async listForPeriod(issuerId: string, start: Date, end: Date): Promise<RedemptionRequest[]> {
    const { rows } = await this.db.query<RedemptionRow>(
      `SELECT ${REDEMPTION_COLUMNS} FROM redemption_requests
        WHERE issuer_id = $1 AND requested_at >= $2 AND requested_at <= $3
        ORDER BY requested_at, id`,
      [issuerId, start, end],
    );
    return rows.map(toRedemptionRequest);
  }

  /** Requests still on the SLA clock, most urgent first. */
  async listOpen(issuerId: string): Promise<RedemptionRequest[]> {
    const { rows } = await this.db.query<RedemptionRow>(
      `SELECT ${REDEMPTION_COLUMNS} FROM redemption_requests
        WHERE issuer_id = $1 AND status IN ('RECEIVED', 'PROCESSING')
        ORDER BY sla_deadline, id`,
      [issuerId],
    );
    return rows.map(toRedemptionRequest);
  }
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Constraint name of a unique violation, or null when `error` is something else.
 *
 * Returns the empty string when the driver reports no constraint name, which
 * still means "unique violation" — callers must distinguish null from ''.
 */
function uniqueViolation(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== UNIQUE_VIOLATION) return null;
  return typeof candidate.constraint === 'string' ? candidate.constraint : '';
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly string[],
  column: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`column ${column} holds an unrecognised value: ${String(value)}`);
  }
  return value as T;
}

/**
 * A merkle root: exactly 64 lowercase hex characters, checked on read *and* write.
 *
 * `anchors.merkle_root` is CHAR(64), so Postgres blank-pads anything shorter and
 * hands it back padded — 'abc' is read as `'abc' + 61 spaces`. That is a silently
 * altered commitment, and it does not stay inert: `EvidenceService.sweepPending`
 * feeds the `merkleRoot` it read from this store straight back into
 * `submitAnchor`, so a padded value would be anchored on-chain as though it were
 * the real root.
 *
 * Guarding only the write path would cover only the rows this store inserted; a
 * restored backup, a manual correction or a future writer would still surface a
 * corrupted root as if it were genuine. A length check alone is useless on read
 * (CHAR(64) always returns 64 characters), so the format is what is verified.
 */
function requireMerkleRoot(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(
      `${label} must be exactly 64 lowercase hex characters, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireDate(value: unknown, column: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`column ${column} is not a valid timestamp: ${String(value)}`);
  }
  return value;
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`column ${column} is not an integer: ${String(value)}`);
  }
  return value;
}
