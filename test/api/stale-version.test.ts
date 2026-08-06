import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from '../db/harness.js';
import { bearer, createTestServer, seedBackedPeriod, seedUser } from './helpers.js';
import type { TestServer, TestUser } from './helpers.js';

/**
 * A signature must bind the document that was examined.
 *
 * `POST /api/reports/:id/approvals` recomputes the period from stored facts
 * before admitting a decision, on the sound reasoning that facts arrive between
 * generation and signing and a signer is answering whether the figures are
 * correct *now*. But the artifact that is signed, hashed, anchored and published
 * is `version.payload` — the snapshot taken at generation. Recomputing without
 * comparing asks the question of one document and records the answer against
 * another.
 *
 * The gap is not theoretical and it is not rare: a corrected custodian statement
 * or a late supply observation is the ordinary month-end flow, and
 * `listCurrentAsOf` takes the latest non-superseded fact per custodian, so a
 * single arriving row changes the recomputation while the stored payload stands
 * still. Before this was closed, a version generated with a CRITICAL breach
 * recorded in it collected all four statutory signatures — including both
 * executive attestations that the report is "true and correct in all material
 * respects" — because the gate was reading cleaner figures than the ones being
 * certified, and the published disclosure then served the stale ones.
 */

const available = await databaseAvailable();

const CHAIN = ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'] as const;

/** The Base deployment's supply row, removed and later restored by these tests. */
const BASE_SUPPLY = {
  blockNumber: 12_000_000,
  blockTimestamp: new Date('2026-03-31T23:50:00.000Z'),
  totalSupply: '3000000000000',
};

describe.skipIf(!available)('certification refuses a version the facts have outrun', () => {
  let server: TestServer;
  let preparer: TestUser;
  /**
   * One user per stage, because four eyes means four people.
   *
   * The first draft of this suite gave a single user all four roles and got a
   * 403 on the second signature — the service check and the
   * UNIQUE (report_version_id, actor_id) constraint from migration 008 doing
   * their job. Worth keeping the fixture honest: a chain driven by one actor
   * would not be a chain.
   */
  const signers: Record<string, TestUser> = {};
  let periodId: string;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await seedBackedPeriod();
    server = await createTestServer();

    for (const role of CHAIN) {
      signers[role] = await seedUser({
        roles: [role],
        email: `${role.toLowerCase()}@acme.test`,
        stepUp: true,
      });
    }
    preparer = signers['PREPARER']!;

    const opened = await server.app.inject({
      method: 'POST',
      url: '/api/periods',
      headers: bearer(preparer),
      payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
    });
    expect(opened.statusCode).toBe(201);
    periodId = opened.json().id as string;
  });

  afterAll(async () => {
    await server?.app.close();
  });

  async function generate(): Promise<{ versionId: string; criticalBreaches: number }> {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(preparer),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { versionId: body.versionId as string, criticalBreaches: body.criticalBreaches as number };
  }

  function approve(versionId: string, role: string) {
    return server.app.inject({
      method: 'POST',
      url: `/api/reports/${versionId}/approvals`,
      headers: bearer(signers[role]!),
      payload: { role, decision: 'APPROVED' },
    });
  }

  async function dropBaseSupply(): Promise<void> {
    await testPool().query('DELETE FROM supply_facts WHERE token_deployment_id = $1', [
      SEED_IDS.base,
    ]);
  }

  async function restoreBaseSupply(): Promise<void> {
    await testPool().query(
      `INSERT INTO supply_facts (token_deployment_id, block_number, block_timestamp, total_supply, observed_at)
       VALUES ($1, $2, $3, $4, $3)`,
      [SEED_IDS.base, BASE_SUPPLY.blockNumber, BASE_SUPPLY.blockTimestamp, BASE_SUPPLY.totalSupply],
    );
  }

  it('refuses the first signature once a late supply observation lands', async () => {
    // Generate while one chain is unobserved: the payload understates outstanding
    // and records a CRITICAL NO_SUPPLY_OBSERVATION breach.
    await dropBaseSupply();
    const { versionId, criticalBreaches } = await generate();
    expect(criticalBreaches).toBe(1);

    const stored = await testPool().query<{ payload: Record<string, never> }>(
      'SELECT payload FROM report_versions WHERE id = $1',
      [versionId],
    );
    const payload = stored.rows[0]!.payload as unknown as {
      outstanding: { totalUsd: string };
      collateralization: { ratioPercent: string };
    };
    expect(payload.outstanding.totalUsd).toBe('7000000.00');
    expect(payload.collateralization.ratioPercent).toBe('150.00');

    // The observation arrives. The live computation is now clean, so the old gate
    // — which read only this — would have admitted the signature.
    await restoreBaseSupply();

    const response = await approve(versionId, 'PREPARER');
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/facts behind report version 1 have changed/i);
  });

  it('names regenerating as the way forward, and that path works', async () => {
    await dropBaseSupply();
    const first = await generate();
    await restoreBaseSupply();

    const refused = await approve(first.versionId, 'PREPARER');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toMatch(/regenerate the report and certify the new version/i);

    // Follow the instruction the error gives.
    const second = await generate();
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.criticalBreaches).toBe(0);

    const accepted = await approve(second.versionId, 'PREPARER');
    expect(accepted.statusCode).toBe(201);
  });

  it('lets a version whose facts have not moved be certified as before', async () => {
    // The guard must not fire on the ordinary case, or it would block every
    // filing. This is the regression that matters most.
    const { versionId, criticalBreaches } = await generate();
    expect(criticalBreaches).toBe(0);

    for (const role of CHAIN) {
      const response = await approve(versionId, role);
      expect(response.statusCode, `${role} should be accepted`).toBe(201);
    }

    const period = await server.app.inject({
      method: 'GET',
      url: `/api/periods/${periodId}`,
      headers: bearer(preparer),
    });
    expect(period.json().status).toBe('CERTIFIED');
  });

  it('catches a correction that changes a figure without changing a breach', async () => {
    // The check is a hash comparison, not a breach comparison, so it holds for
    // drift that no rule flags: here a superseding reserve fact that moves the
    // collateralization ratio while leaving the report clean by every rule.
    const { versionId } = await generate();

    const original = await testPool().query<{ id: string }>(
      `SELECT id FROM reserve_facts WHERE issuer_id = $1 AND custodian_id = $2
        AND instrument_category = 'CASH' LIMIT 1`,
      [SEED_IDS.issuerId, SEED_IDS.bny],
    );
    const supersededId = original.rows[0]!.id;

    const replacement = await testPool().query<{ id: string }>(
      `INSERT INTO reserve_facts
         (issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip, currency,
          face_value_minor, market_value_minor, maturity_date, source_hash)
       VALUES ($1, $2, $3, $3, 'CASH', NULL, 'USD', 210000000, 210000000, NULL, $4)
       RETURNING id`,
      [SEED_IDS.issuerId, SEED_IDS.bny, new Date('2026-03-31T20:00:00.000Z'), 'e'.repeat(64)],
    );
    await testPool().query('UPDATE reserve_facts SET superseded_by = $1 WHERE id = $2', [
      replacement.rows[0]!.id,
      supersededId,
    ]);

    const response = await approve(versionId, 'PREPARER');
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/have changed since it was generated/i);
  });

  it('refuses mid-chain, not only at the first signature', async () => {
    // A correction can land after two people have already signed. The remaining
    // signers must not be able to complete a chain over figures that moved.
    const { versionId } = await generate();
    expect((await approve(versionId, 'PREPARER')).statusCode).toBe(201);
    expect((await approve(versionId, 'COMPLIANCE')).statusCode).toBe(201);

    await testPool().query(
      `INSERT INTO supply_facts (token_deployment_id, block_number, block_timestamp, total_supply, observed_at)
       VALUES ($1, 21500001, $2, 7100000000000, $2)`,
      [SEED_IDS.ethereum, new Date('2026-03-31T23:55:00.000Z')],
    );

    const cfo = await approve(versionId, 'CFO');
    expect(cfo.statusCode).toBe(409);

    const period = await server.app.inject({
      method: 'GET',
      url: `/api/periods/${periodId}`,
      headers: bearer(preparer),
    });
    expect(period.json().status).not.toBe('CERTIFIED');
  });

  it('still allows a REJECTION when the version has gone stale', async () => {
    // Refusing to certify stale figures must not also trap the version: someone
    // has to be able to reject it and move on.
    await dropBaseSupply();
    const { versionId } = await generate();
    await restoreBaseSupply();

    const rejected = await server.app.inject({
      method: 'POST',
      url: `/api/reports/${versionId}/approvals`,
      headers: bearer(preparer),
      payload: { role: 'PREPARER', decision: 'REJECTED' },
    });

    expect(rejected.statusCode).toBe(201);
    expect(rejected.json().decision).toBe('REJECTED');
  });
});
