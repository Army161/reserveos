import { beforeEach, describe, expect, it } from 'vitest';
import { PgAnchorStore, PgApprovalStore, PgRedemptionStore } from '../../src/db/stores/workflow.js';
import { US_FEDERAL } from '../../src/domain/calendar.js';
import { FakeKaleidoClient } from '../../src/kaleido/fake.js';
import {
  APPROVAL_ROLES,
  ATTESTATION_TEXT,
  CertificationError,
  CertificationService,
  InMemoryApprovalStore,
  type ApprovalRecord,
  type ApprovalRole,
  type ApprovalStore,
  type Approver,
} from '../../src/services/certification.js';
import {
  EvidenceService,
  InMemoryAnchorStore,
  type AnchorRecord,
  type AnchorStore,
} from '../../src/services/evidence.js';
import {
  openRequest,
  settle,
  type RedemptionRequest,
  type RedemptionStatus,
} from '../../src/services/redemption.js';
import { SEED_IDS, databaseAvailable, resetDatabase, seedTenant, testPool } from './harness.js';

/**
 * The Postgres workflow stores must be substitutable for the in-memory ones the
 * services were built against. The parity suites below run one identical
 * sequence of calls through both implementations and compare every observable
 * result — including which calls throw and with what message — because a store
 * that merely "looks right" but reorders, coerces or swallows a constraint
 * violation would change certified output without failing any narrower test.
 */

const available = await databaseAvailable();

/** Deterministic, ascending UUIDs so ordering assertions are stable. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const ROOT = 'a'.repeat(64);
const PAYLOAD_HASH = 'b'.repeat(64);
const SUBJECT_A = uuid(0xa1);
const SUBJECT_B = uuid(0xb1);
const PERIOD_ID = uuid(0x31);
const VERSION_A = uuid(0x41);
const VERSION_B = uuid(0x42);

const ACTOR_IDS: Record<ApprovalRole, string> = {
  PREPARER: uuid(0x901),
  COMPLIANCE: uuid(0x902),
  CFO: uuid(0x903),
  CEO: uuid(0x904),
};

/** Run `fn` and reduce its outcome to a comparable string. */
async function capture(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'resolved';
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

async function seedReportVersion(versionId: string, version: number): Promise<void> {
  const pool = testPool();
  await pool.query(
    `INSERT INTO reporting_periods (id, issuer_id, period_start, period_end)
     VALUES ($1, $2, '2026-03-01', '2026-03-31')
     ON CONFLICT (id) DO NOTHING`,
    [PERIOD_ID, SEED_IDS.issuerId],
  );
  await pool.query(
    `INSERT INTO report_versions
       (id, period_id, version, payload, payload_hash, generated_at, generated_by)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6)`,
    [
      versionId,
      PERIOD_ID,
      version,
      String(version).padStart(64, 'e'),
      new Date('2026-04-01T00:00:00.000Z'),
      SEED_IDS.issuerId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

function pendingAnchor(id: string, subjectId: string): AnchorRecord {
  return {
    id,
    issuerId: SEED_IDS.issuerId,
    subjectType: 'DAILY_ROLLUP',
    subjectId,
    merkleRoot: ROOT,
    operationId: null,
    transactionHash: null,
    blockNumber: null,
    status: 'PENDING',
    attempts: 0,
    lastError: null,
  };
}

function bySubject(records: readonly AnchorRecord[]): AnchorRecord[] {
  return [...records].sort((a, b) => a.subjectId.localeCompare(b.subjectId));
}

async function anchorSequence(store: AnchorStore): Promise<unknown[]> {
  const a = pendingAnchor(uuid(1), SUBJECT_A);
  const b = pendingAnchor(uuid(2), SUBJECT_B);
  const steps: unknown[] = [];

  steps.push(await store.find('DAILY_ROLLUP', SUBJECT_A));

  await store.insert(a);
  await store.insert(b);
  steps.push(await store.find('DAILY_ROLLUP', SUBJECT_A));

  // A retry that minted a fresh id must still collide on the subject, or the
  // same commitment gets anchored twice.
  steps.push(await capture(() => store.insert(pendingAnchor(uuid(3), SUBJECT_A))));
  steps.push(bySubject(await store.listPending()));

  await store.update({
    ...a,
    operationId: 'op-7',
    transactionHash: `0x${'d'.repeat(64)}`,
    blockNumber: 9_007_199_254_740_993n,
    status: 'CONFIRMED',
    attempts: 2,
  });
  steps.push(await store.find('DAILY_ROLLUP', SUBJECT_A));
  steps.push(bySubject(await store.listPending()));

  await store.update({ ...b, attempts: 1, lastError: 'connector unavailable' });
  steps.push(await store.find('DAILY_ROLLUP', SUBJECT_B));

  // Subject type is part of the identity, not decoration.
  steps.push(await store.find('REPORT_VERSION', SUBJECT_A));

  return steps;
}

describe.skipIf(!available)('PgAnchorStore', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  it('is observationally identical to InMemoryAnchorStore', async () => {
    const memory = await anchorSequence(new InMemoryAnchorStore());
    const postgres = await anchorSequence(new PgAnchorStore(testPool()));

    // Guard against a vacuous pass: the sequence must really move state.
    expect(memory[0]).toBeNull();
    expect(memory[2]).toBe(`Error: duplicate anchor DAILY_ROLLUP:${SUBJECT_A}`);
    expect(bySubject(memory[3] as AnchorRecord[]).map((r) => r.subjectId)).toEqual([
      SUBJECT_A,
      SUBJECT_B,
    ]);
    const confirmed = memory[4] as AnchorRecord;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.blockNumber).toBe(9_007_199_254_740_993n);

    expect(postgres).toEqual(memory);
  });

  it('round-trips a block number that a JS number cannot hold', async () => {
    const store = new PgAnchorStore(testPool());
    const record = pendingAnchor(uuid(31), SUBJECT_A);
    await store.insert(record);

    const maxBigint = 9_223_372_036_854_775_807n;
    await store.update({
      ...record,
      operationId: 'op-1',
      transactionHash: '0xfeed',
      blockNumber: maxBigint,
      status: 'CONFIRMED',
      attempts: 1,
    });

    const read = await store.find('DAILY_ROLLUP', SUBJECT_A);
    expect(read?.blockNumber).toBe(maxBigint);
    expect(read?.blockNumber?.toString()).toBe('9223372036854775807');
  });

  it('stamps anchored_at on the first confirmation and does not restamp it', async () => {
    const pool = testPool();
    const store = new PgAnchorStore(pool);
    const record = pendingAnchor(uuid(32), SUBJECT_A);
    await store.insert(record);

    const pending = await pool.query<{ anchored_at: Date | null }>(
      `SELECT anchored_at FROM anchors WHERE id = $1`,
      [record.id],
    );
    expect(pending.rows[0]?.anchored_at).toBeNull();

    const confirmed = { ...record, status: 'CONFIRMED' as const, attempts: 1 };
    await store.update(confirmed);
    const first = await pool.query<{ anchored_at: Date | null }>(
      `SELECT anchored_at FROM anchors WHERE id = $1`,
      [record.id],
    );
    const stamp = first.rows[0]?.anchored_at;
    expect(stamp).toBeInstanceOf(Date);

    await store.update({ ...confirmed, attempts: 2 });
    const second = await pool.query<{ anchored_at: Date | null }>(
      `SELECT anchored_at FROM anchors WHERE id = $1`,
      [record.id],
    );
    expect(second.rows[0]?.anchored_at).toEqual(stamp);
  });

  it('lists pending anchors oldest first', async () => {
    const pool = testPool();
    const store = new PgAnchorStore(pool);
    const ids = [uuid(41), uuid(42), uuid(43)];
    const subjects = [uuid(0x51), uuid(0x52), uuid(0x53)];
    for (let i = 0; i < ids.length; i += 1) {
      await store.insert(pendingAnchor(ids[i]!, subjects[i]!));
    }

    // created_at defaults to now(); force an order insertion order does not imply.
    await pool.query(
      `UPDATE anchors
          SET created_at = CASE id
                             WHEN $1::uuid THEN TIMESTAMPTZ '2026-03-03T00:00:00Z'
                             WHEN $2::uuid THEN TIMESTAMPTZ '2026-03-01T00:00:00Z'
                             ELSE TIMESTAMPTZ '2026-03-02T00:00:00Z'
                           END`,
      [ids[0], ids[1]],
    );

    const pending = await store.listPending();
    expect(pending.map((r) => r.subjectId)).toEqual([subjects[1], subjects[2], subjects[0]]);
  });

  it('refuses a merkle root that CHAR(64) would silently blank-pad', async () => {
    const store = new PgAnchorStore(testPool());
    await expect(
      store.insert({ ...pendingAnchor(uuid(44), SUBJECT_A), merkleRoot: 'abc' }),
    ).rejects.toThrow(/64 lowercase hex characters/);
  });

  it('refuses a merkle root that is 64 characters but not a hex digest', async () => {
    const store = new PgAnchorStore(testPool());
    // Right length, wrong alphabet: CHAR(64) stores this happily and reads it
    // back unchanged, so only a format check catches it.
    await expect(
      store.insert({ ...pendingAnchor(uuid(46), SUBJECT_A), merkleRoot: `${'a'.repeat(63)} ` }),
    ).rejects.toThrow(/64 lowercase hex characters/);
  });

  it('cannot store a malformed merkle root, at either layer', async () => {
    const pool = testPool();
    const store = new PgAnchorStore(pool);

    // Layer 1 — the database. `merkle_root` was CHAR(64), which blank-pads: a
    // short value read back as 'abc' + 61 spaces, so a length check on read
    // always passed and sweepPending would re-submit the padded string to the
    // chain as if it were the real commitment. Migration 003 replaced the column
    // with TEXT + a format CHECK, which kills the class for every writer, not
    // just this store.
    await expect(
      pool.query(
        `INSERT INTO anchors (id, issuer_id, subject_type, subject_id, merkle_root, status, attempts)
         VALUES ($1, $2, 'DAILY_ROLLUP', $3, 'abc', 'PENDING', 0)`,
        [uuid(47), SEED_IDS.issuerId, SUBJECT_A],
      ),
    ).rejects.toThrow(/anchors_merkle_root_format/);

    // Layer 2 — the store still rejects it first, with a message that names the
    // problem rather than surfacing a constraint code to the caller.
    await expect(
      store.insert({
        id: uuid(48),
        issuerId: SEED_IDS.issuerId,
        subjectType: 'DAILY_ROLLUP',
        subjectId: SUBJECT_A,
        merkleRoot: 'abc',
        operationId: null,
        transactionHash: null,
        blockNumber: null,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
      }),
    ).rejects.toThrow(/64 lowercase hex characters/);
  });

  it('throws rather than silently dropping an update to a missing anchor', async () => {
    const store = new PgAnchorStore(testPool());
    await expect(store.update(pendingAnchor(uuid(45), SUBJECT_A))).rejects.toThrow(
      /does not exist/,
    );
  });
});

// ---------------------------------------------------------------------------
// EvidenceService driven against Postgres
// ---------------------------------------------------------------------------

describe.skipIf(!available)('EvidenceService on PgAnchorStore', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  function build(): {
    kaleido: FakeKaleidoClient;
    store: PgAnchorStore;
    service: EvidenceService;
  } {
    const kaleido = new FakeKaleidoClient();
    const store = new PgAnchorStore(testPool());
    let counter = 100;
    const service = new EvidenceService({ store, kaleido, newId: () => uuid(++counter) });
    return { kaleido, store, service };
  }

  const anchorParams = {
    issuerId: SEED_IDS.issuerId,
    subjectType: 'REPORT_VERSION' as const,
    subjectId: SUBJECT_A,
    merkleRoot: ROOT,
  };

  it('persists a confirmed anchor, receipt and all', async () => {
    const { service, store } = build();
    await service.anchor(anchorParams);

    // Deliberately re-read from the database rather than trusting the return value.
    const persisted = await store.find('REPORT_VERSION', SUBJECT_A);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe('CONFIRMED');
    expect(persisted?.transactionHash).toMatch(/^0x/);
    expect(persisted?.blockNumber).toBe(1001n);
    expect(persisted?.attempts).toBe(1);
    expect(persisted?.lastError).toBeNull();
    expect(persisted?.merkleRoot).toBe(ROOT);

    const { rows } = await testPool().query<{ anchored_at: Date | null }>(
      `SELECT anchored_at FROM anchors WHERE subject_id = $1`,
      [SUBJECT_A],
    );
    expect(rows[0]?.anchored_at).toBeInstanceOf(Date);
  });

  it('leaves a PENDING row carrying the error when submission fails', async () => {
    const { kaleido, service, store } = build();
    kaleido.failNextSubmission('connector unavailable');
    await service.anchor(anchorParams);

    const persisted = await store.find('REPORT_VERSION', SUBJECT_A);
    expect(persisted?.status).toBe('PENDING');
    expect(persisted?.lastError).toBe('connector unavailable');
    expect(persisted?.attempts).toBe(1);
    expect(persisted?.operationId).toBeNull();
    expect(kaleido.anchorCount).toBe(0);

    const { rows } = await testPool().query<{ anchored_at: Date | null }>(
      `SELECT anchored_at FROM anchors WHERE subject_id = $1`,
      [SUBJECT_A],
    );
    expect(rows[0]?.anchored_at).toBeNull();
  });

  it('recovers the failed submission on the next sweep', async () => {
    const { kaleido, service, store } = build();
    kaleido.failNextSubmission('connector unavailable');
    await service.anchor(anchorParams);

    await service.sweepPending();

    const persisted = await store.find('REPORT_VERSION', SUBJECT_A);
    expect(persisted?.status).toBe('CONFIRMED');
    expect(persisted?.attempts).toBe(2);
    expect(persisted?.lastError).toBeNull();
    expect(persisted?.blockNumber).toBe(1001n);
    expect(kaleido.anchorCount).toBe(1);
    expect(await store.listPending()).toEqual([]);
  });

  it('does not re-submit a subject that is already confirmed', async () => {
    const { kaleido, service } = build();
    await service.anchor(anchorParams);
    await service.anchor(anchorParams);
    await service.anchor(anchorParams);

    expect(kaleido.anchorCount).toBe(1);
    const { rows } = await testPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM anchors WHERE subject_id = $1`,
      [SUBJECT_A],
    );
    expect(rows[0]?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function approval(
  id: string,
  reportVersionId: string,
  role: ApprovalRole,
  signedAt: string,
): ApprovalRecord {
  return {
    id,
    reportVersionId,
    role,
    actorId: ACTOR_IDS[role],
    actorEmail: `${role.toLowerCase()}@acme.test`,
    decision: 'APPROVED',
    attestationText: ATTESTATION_TEXT[role],
    signature: `sig-${role}`,
    signedAt: new Date(signedAt),
    pmsDecisionId: `pms-${role}`,
  };
}

async function approvalSequence(store: ApprovalStore): Promise<unknown[]> {
  const steps: unknown[] = [];

  steps.push(await store.listForVersion(VERSION_A));

  await store.insert(approval(uuid(61), VERSION_A, 'PREPARER', '2026-04-01T09:00:00.000Z'));
  await store.insert(approval(uuid(62), VERSION_A, 'COMPLIANCE', '2026-04-01T10:00:00.000Z'));
  steps.push(await store.listForVersion(VERSION_A));

  steps.push(
    await capture(() =>
      store.insert(approval(uuid(63), VERSION_A, 'PREPARER', '2026-04-01T11:00:00.000Z')),
    ),
  );
  steps.push(await store.listForVersion(VERSION_A));

  // A different version must not see another version's approvals.
  steps.push(await store.listForVersion(VERSION_B));

  return steps;
}

describe.skipIf(!available)('PgApprovalStore', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await seedReportVersion(VERSION_A, 1);
  });

  it('is observationally identical to InMemoryApprovalStore', async () => {
    const memory = await approvalSequence(new InMemoryApprovalStore());
    const postgres = await approvalSequence(new PgApprovalStore(testPool()));

    expect(memory[0]).toEqual([]);
    expect((memory[1] as ApprovalRecord[]).map((a) => a.role)).toEqual(['PREPARER', 'COMPLIANCE']);
    expect(memory[2]).toBe('CertificationError: PREPARER has already decided on this version');
    expect((memory[3] as ApprovalRecord[])).toHaveLength(2);

    expect(postgres).toEqual(memory);
  });

  it('preserves the exact attestation wording and signature', async () => {
    const store = new PgApprovalStore(testPool());
    const record = approval(uuid(64), VERSION_A, 'CFO', '2026-04-01T12:00:00.000Z');
    await store.insert(record);

    const [read] = await store.listForVersion(VERSION_A);
    expect(read).toEqual(record);
    expect(read?.attestationText).toBe(ATTESTATION_TEXT.CFO);
  });

  it('refuses to read an approval with no Policy Manager decision id', async () => {
    const pool = testPool();
    const store = new PgApprovalStore(pool);
    // approvals.pms_decision_id is nullable, so this row is reachable without
    // going through the store. An approval with no PMS decision has no
    // independent record that the authorization ever happened; inventing one, or
    // surfacing it as an ordinary approval, would forge that link.
    await pool.query(
      `INSERT INTO approvals (id, report_version_id, role, actor_id, actor_email, decision,
                              attestation_text, signature, signed_at, pms_decision_id)
       VALUES ($1, $2, 'PREPARER', $3, 'preparer@acme.test', 'APPROVED', $4, 'sig', now(), NULL)`,
      [uuid(68), VERSION_A, ACTOR_IDS.PREPARER, ATTESTATION_TEXT.PREPARER],
    );

    await expect(store.listForVersion(VERSION_A)).rejects.toThrow(/no pms_decision_id/);
  });

  it('rejects a second decision by the same role with a CertificationError', async () => {
    const store = new PgApprovalStore(testPool());
    await store.insert(approval(uuid(65), VERSION_A, 'CEO', '2026-04-01T12:00:00.000Z'));

    await expect(
      store.insert(approval(uuid(66), VERSION_A, 'CEO', '2026-04-01T13:00:00.000Z')),
    ).rejects.toThrow(CertificationError);
    await expect(
      store.insert(approval(uuid(67), VERSION_A, 'CEO', '2026-04-01T14:00:00.000Z')),
    ).rejects.toThrow(/CEO has already decided on this version/);
  });
});

// ---------------------------------------------------------------------------
// CertificationService driven against Postgres
// ---------------------------------------------------------------------------

describe.skipIf(!available)('CertificationService on PgApprovalStore', () => {
  let kaleido: FakeKaleidoClient;
  let approvals: PgApprovalStore;
  let anchors: PgAnchorStore;
  let service: CertificationService;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await seedReportVersion(VERSION_A, 1);
    await seedReportVersion(VERSION_B, 2);

    const pool = testPool();
    kaleido = new FakeKaleidoClient();
    approvals = new PgApprovalStore(pool);
    anchors = new PgAnchorStore(pool);

    let counter = 200;
    let tick = Date.parse('2026-04-02T15:00:00.000Z');
    const newId = (): string => uuid(++counter);

    service = new CertificationService({
      approvals,
      kaleido,
      evidence: new EvidenceService({ store: anchors, kaleido, newId }),
      sign: async ({ payloadHash, attestationText }) =>
        `sig(${payloadHash.slice(0, 8)}|${attestationText.slice(0, 12)})`,
      newId,
      // Ascending so signed_at ordering reflects the order roles actually signed.
      now: () => new Date((tick += 1000)),
    });
  });

  function approver(role: ApprovalRole): Approver {
    return {
      id: ACTOR_IDS[role],
      email: `${role.toLowerCase()}@acme.test`,
      roles: [role],
      stepUpVerified: true,
    };
  }

  function approve(role: ApprovalRole, reportVersionId = VERSION_A): Promise<unknown> {
    return service.submitApproval({
      issuerId: SEED_IDS.issuerId,
      reportVersionId,
      payloadHash: PAYLOAD_HASH,
      actor: approver(role),
      role,
      decision: 'APPROVED',
      hasCriticalBreach: false,
    });
  }

  it('certifies through the full PREPARER → CEO chain', async () => {
    expect(await service.nextRole(VERSION_A)).toBe('PREPARER');

    await approve('PREPARER');
    await approve('COMPLIANCE');
    await approve('CFO');
    const final = (await approve('CEO')) as { certified: boolean };

    expect(final.certified).toBe(true);
    expect(await service.nextRole(VERSION_A)).toBeNull();

    const persisted = await approvals.listForVersion(VERSION_A);
    expect(persisted.map((a) => a.role)).toEqual([...APPROVAL_ROLES]);
    expect(persisted.every((a) => a.decision === 'APPROVED')).toBe(true);
    expect(persisted.map((a) => a.attestationText)).toEqual(
      APPROVAL_ROLES.map((r) => ATTESTATION_TEXT[r]),
    );

    // Every approval, plus the version itself, is anchored and confirmed.
    const { rows } = await testPool().query<{ subject_type: string; status: string }>(
      `SELECT subject_type, status FROM anchors`,
    );
    expect(rows.filter((r) => r.subject_type === 'APPROVAL')).toHaveLength(4);
    expect(rows.filter((r) => r.subject_type === 'REPORT_VERSION')).toHaveLength(1);
    expect(rows.every((r) => r.status === 'CONFIRMED')).toBe(true);
  });

  it('rejects an out-of-order approval and writes nothing', async () => {
    await expect(approve('CEO')).rejects.toThrow(/PREPARER must act before CEO/);
    expect(await approvals.listForVersion(VERSION_A)).toEqual([]);
  });

  it('rejects a second decision from the same role', async () => {
    await approve('PREPARER');
    // The service's stage check fires first; the store's unique constraint is the
    // backstop that survives a concurrent second request.
    await expect(approve('PREPARER')).rejects.toThrow(CertificationError);
    expect(await approvals.listForVersion(VERSION_A)).toHaveLength(1);
  });

  it('keeps versions independent', async () => {
    await approve('PREPARER', VERSION_A);
    await approve('PREPARER', VERSION_B);

    expect(await approvals.listForVersion(VERSION_A)).toHaveLength(1);
    expect(await approvals.listForVersion(VERSION_B)).toHaveLength(1);
    expect(await service.nextRole(VERSION_B)).toBe('COMPLIANCE');
  });
});

// ---------------------------------------------------------------------------
// Redemption requests
// ---------------------------------------------------------------------------

function redemption(params: {
  id: string;
  externalRef: string;
  requestedAt: string;
  slaDeadline: string;
  amountMinor: bigint;
  status: RedemptionStatus;
  settledAt: string | null;
  issuerId?: string;
}): RedemptionRequest {
  return {
    id: params.id,
    issuerId: params.issuerId ?? SEED_IDS.issuerId,
    externalRef: params.externalRef,
    requestedAt: new Date(params.requestedAt),
    amountMinor: params.amountMinor,
    slaDeadline: new Date(params.slaDeadline),
    settledAt: params.settledAt === null ? null : new Date(params.settledAt),
    status: params.status,
  };
}

const PERIOD_START = new Date('2026-04-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-04-30T23:59:59.999Z');

describe.skipIf(!available)('PgRedemptionStore', () => {
  let store: PgRedemptionStore;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    store = new PgRedemptionStore(testPool());
  });

  it('round-trips an amount a JS number would round', async () => {
    const request = redemption({
      id: uuid(0x71),
      externalRef: 'RDM-1',
      requestedAt: '2026-04-02T12:00:00.000Z',
      slaDeadline: '2026-04-06T23:59:59.999Z',
      // 2^53 + 1: representable as a bigint, not as a double.
      amountMinor: 9_007_199_254_740_993n,
      status: 'RECEIVED',
      settledAt: null,
    });
    await store.insert(request);

    const [read] = await store.listForPeriod(SEED_IDS.issuerId, PERIOD_START, PERIOD_END);
    expect(read).toEqual(request);
    expect(read?.amountMinor).toBe(9_007_199_254_740_993n);
  });

  it('refuses a duplicate external reference for the same issuer', async () => {
    const request = redemption({
      id: uuid(0x72),
      externalRef: 'RDM-1',
      requestedAt: '2026-04-02T12:00:00.000Z',
      slaDeadline: '2026-04-06T23:59:59.999Z',
      amountMinor: 1_000_00n,
      status: 'RECEIVED',
      settledAt: null,
    });
    await store.insert(request);

    await expect(store.insert({ ...request, id: uuid(0x73) })).rejects.toThrow(
      /duplicate redemption request RDM-1/,
    );
  });

  it('persists a settlement produced by the domain layer', async () => {
    const request = openRequest({
      id: uuid(0x74),
      issuerId: SEED_IDS.issuerId,
      externalRef: 'RDM-DOMAIN',
      requestedAt: new Date('2026-04-02T12:00:00.000Z'),
      amountMinor: 250_000_00n,
      calendar: US_FEDERAL,
    });
    await store.insert(request);
    expect(await store.listOpen(SEED_IDS.issuerId)).toHaveLength(1);

    const settled = settle(request, new Date('2026-04-03T09:30:00.000Z'));
    await store.update(settled);

    const [read] = await store.listForPeriod(SEED_IDS.issuerId, PERIOD_START, PERIOD_END);
    expect(read).toEqual(settled);
    expect(read?.status).toBe('SETTLED');
    expect(read?.settledAt?.toISOString()).toBe('2026-04-03T09:30:00.000Z');
    // Settled work leaves the SLA queue.
    expect(await store.listOpen(SEED_IDS.issuerId)).toEqual([]);
  });

  it('records a late settlement as BREACHED', async () => {
    const request = openRequest({
      id: uuid(0x75),
      issuerId: SEED_IDS.issuerId,
      externalRef: 'RDM-LATE',
      requestedAt: new Date('2026-04-02T12:00:00.000Z'),
      amountMinor: 5_000_00n,
      calendar: US_FEDERAL,
    });
    await store.insert(request);

    const late = settle(request, new Date(request.slaDeadline.getTime() + 60_000));
    await store.update(late);

    const [read] = await store.listForPeriod(SEED_IDS.issuerId, PERIOD_START, PERIOD_END);
    expect(read?.status).toBe('BREACHED');
    expect(await store.listOpen(SEED_IDS.issuerId)).toEqual([]);
  });

  it('includes both period boundaries and excludes what falls outside', async () => {
    const rows: readonly [string, string][] = [
      ['BEFORE', '2026-03-31T23:59:59.999Z'],
      ['AT-START', '2026-04-01T00:00:00.000Z'],
      ['MIDDLE', '2026-04-15T08:00:00.000Z'],
      ['AT-END', '2026-04-30T23:59:59.999Z'],
      ['AFTER', '2026-05-01T00:00:00.000Z'],
    ];
    for (const [index, [ref, at]] of rows.entries()) {
      await store.insert(
        redemption({
          id: uuid(0x80 + index),
          externalRef: ref,
          requestedAt: at,
          slaDeadline: '2026-05-10T00:00:00.000Z',
          amountMinor: 1_00n,
          status: 'RECEIVED',
          settledAt: null,
        }),
      );
    }

    const inPeriod = await store.listForPeriod(SEED_IDS.issuerId, PERIOD_START, PERIOD_END);
    expect(inPeriod.map((r) => r.externalRef)).toEqual(['AT-START', 'MIDDLE', 'AT-END']);
  });

  it('lists open requests by SLA deadline, most urgent first', async () => {
    const rows: readonly [string, string, RedemptionStatus][] = [
      ['LATEST', '2026-04-09T00:00:00.000Z', 'RECEIVED'],
      ['EARLIEST', '2026-04-05T00:00:00.000Z', 'PROCESSING'],
      ['MIDDLE', '2026-04-07T00:00:00.000Z', 'RECEIVED'],
      ['DONE', '2026-04-06T00:00:00.000Z', 'SETTLED'],
      ['MISSED', '2026-04-04T00:00:00.000Z', 'BREACHED'],
      ['REFUSED', '2026-04-03T00:00:00.000Z', 'REJECTED'],
    ];
    for (const [index, [ref, deadline, status]] of rows.entries()) {
      await store.insert(
        redemption({
          id: uuid(0x90 + index),
          externalRef: ref,
          requestedAt: '2026-04-02T12:00:00.000Z',
          slaDeadline: deadline,
          amountMinor: 1_00n,
          status,
          settledAt: status === 'SETTLED' ? '2026-04-03T00:00:00.000Z' : null,
        }),
      );
    }

    const open = await store.listOpen(SEED_IDS.issuerId);
    expect(open.map((r) => r.externalRef)).toEqual(['EARLIEST', 'MIDDLE', 'LATEST']);
  });

  it('never returns another issuer\'s requests', async () => {
    const otherIssuer = uuid(0xf1);
    await testPool().query(
      `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
       VALUES ($1, 'Other Trust Co', 'OCC', 'env-other')`,
      [otherIssuer],
    );

    await store.insert(
      redemption({
        id: uuid(0xf2),
        externalRef: 'MINE',
        requestedAt: '2026-04-02T12:00:00.000Z',
        slaDeadline: '2026-04-06T00:00:00.000Z',
        amountMinor: 1_00n,
        status: 'RECEIVED',
        settledAt: null,
      }),
    );
    await store.insert(
      redemption({
        id: uuid(0xf3),
        // Same external ref: uniqueness is per issuer, so this must be accepted.
        externalRef: 'MINE',
        requestedAt: '2026-04-02T12:00:00.000Z',
        slaDeadline: '2026-04-05T00:00:00.000Z',
        amountMinor: 1_00n,
        status: 'RECEIVED',
        settledAt: null,
        issuerId: otherIssuer,
      }),
    );

    expect(
      (await store.listForPeriod(SEED_IDS.issuerId, PERIOD_START, PERIOD_END)).map((r) => r.id),
    ).toEqual([uuid(0xf2)]);
    expect((await store.listOpen(SEED_IDS.issuerId)).map((r) => r.id)).toEqual([uuid(0xf2)]);
    expect((await store.listOpen(otherIssuer)).map((r) => r.id)).toEqual([uuid(0xf3)]);
  });

  it('throws rather than silently dropping an update to a missing request', async () => {
    await expect(
      store.update(
        redemption({
          id: uuid(0xf4),
          externalRef: 'GHOST',
          requestedAt: '2026-04-02T12:00:00.000Z',
          slaDeadline: '2026-04-06T00:00:00.000Z',
          amountMinor: 1_00n,
          status: 'SETTLED',
          settledAt: '2026-04-03T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow(/does not exist/);
  });
});
