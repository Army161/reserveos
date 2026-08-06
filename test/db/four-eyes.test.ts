import { beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';
import { PgApprovalStore } from '../../src/db/stores/workflow.js';
import { PgReportStore } from '../../src/db/stores/reports.js';
import { CertificationError, type ApprovalRecord } from '../../src/services/certification.js';

/**
 * Four eyes, enforced by the database.
 *
 * `CertificationService` checks that the signer is not already in the chain, but
 * that check is read-then-write: two requests carrying the same credential can
 * both read a chain that does not contain the actor and both insert. No
 * application-layer check can close that window. `approvals_one_decision_per_actor`
 * (migration 008) can, because the second INSERT fails however the two interleave.
 *
 * These tests drive the store directly, below the service, so they exercise the
 * constraint rather than the check that usually shields it.
 */

const available = await databaseAvailable();

const VERSION_ID = '88888888-8888-8888-8888-888888888881';
const ACTOR_A = '77777777-7777-7777-7777-777777777771';
const ACTOR_B = '77777777-7777-7777-7777-777777777772';

function approval(overrides: Partial<ApprovalRecord> & { id: string }): ApprovalRecord {
  return {
    reportVersionId: VERSION_ID,
    role: 'PREPARER',
    actorId: ACTOR_A,
    actorEmail: 'a@acme.test',
    decision: 'APPROVED',
    attestationText: 'I prepared this reserve report.',
    signature: 'sig',
    signedAt: new Date('2026-04-02T15:00:00.000Z'),
    pmsDecisionId: 'pms-1',
    ...overrides,
  } as ApprovalRecord;
}

async function seedVersion(): Promise<void> {
  const pool = testPool();
  const period = await new PgReportStore(pool).openPeriod(
    SEED_IDS.issuerId,
    new Date('2026-03-01T00:00:00.000Z'),
    new Date('2026-03-31T00:00:00.000Z'),
  );
  await pool.query(
    `INSERT INTO report_versions (id, period_id, version, payload, payload_hash, generated_at, generated_by)
     VALUES ($1, $2, 1, '{}'::JSONB, $3, now(), $4)`,
    [VERSION_ID, period.id, 'a'.repeat(64), SEED_IDS.issuerId],
  );
}

describe.skipIf(!available)('four-eyes constraint', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await seedVersion();
  });

  it('accepts four different people across the four stages', async () => {
    const store = new PgApprovalStore(testPool());
    const roles = ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'] as const;

    for (const [index, role] of roles.entries()) {
      await store.insert(
        approval({
          id: `1111111${index}-1111-1111-1111-11111111111${index}`,
          role,
          actorId: `7777777${index}-7777-7777-7777-77777777777${index}`,
          actorEmail: `${role.toLowerCase()}@acme.test`,
        }),
      );
    }

    expect(await store.listForVersion(VERSION_ID)).toHaveLength(4);
  });

  it('refuses the same person signing a second stage', async () => {
    const store = new PgApprovalStore(testPool());
    await store.insert(approval({ id: '11111111-1111-1111-1111-111111111111' }));

    await expect(
      store.insert(
        approval({
          id: '11111111-1111-1111-1111-111111111112',
          role: 'COMPLIANCE',
        }),
      ),
    ).rejects.toThrow(CertificationError);
  });

  it('names the person, not the role, when four eyes is what failed', async () => {
    const store = new PgApprovalStore(testPool());
    await store.insert(approval({ id: '11111111-1111-1111-1111-111111111111' }));

    // "CFO has already decided" would send an operator looking for a signature
    // that does not exist. The two constraints mean different things.
    await expect(
      store.insert(approval({ id: '11111111-1111-1111-1111-111111111112', role: 'CFO' })),
    ).rejects.toThrow(/a@acme\.test already recorded a decision.*CFO must be a different person/s);
  });

  it('still reports a repeated stage as a stage clash', async () => {
    const store = new PgApprovalStore(testPool());
    await store.insert(approval({ id: '11111111-1111-1111-1111-111111111111' }));

    await expect(
      store.insert(
        approval({
          id: '11111111-1111-1111-1111-111111111112',
          actorId: ACTOR_B,
          actorEmail: 'b@acme.test',
        }),
      ),
    ).rejects.toThrow(/PREPARER has already decided on this version/);
  });

  it('survives a concurrent race the application check cannot close', async () => {
    const pool = testPool();
    const store = new PgApprovalStore(pool);

    // Both requests read an empty chain, both believe the actor is new, both
    // insert. Exactly one may land.
    const attempts = ['COMPLIANCE', 'CFO', 'CEO', 'PREPARER'].map((role, index) =>
      store
        .insert(
          approval({
            id: `2222222${index}-2222-2222-2222-22222222222${index}`,
            role: role as ApprovalRecord['role'],
          }),
        )
        .then(
          () => 'inserted' as const,
          () => 'refused' as const,
        ),
    );

    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((outcome) => outcome === 'inserted')).toHaveLength(1);

    const stored = await store.listForVersion(VERSION_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.actorId).toBe(ACTOR_A);
  });
});
