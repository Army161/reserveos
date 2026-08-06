import { beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';
import { withTenant } from '../../src/db/pool.js';
import { PgReserveFactStore, PgSupplyFactStore, PgFxRateStore } from '../../src/db/stores/facts.js';
import { PgCustodianStore, PgTokenDeploymentStore } from '../../src/db/stores/reference.js';
import { PgReportStore } from '../../src/db/stores/reports.js';
import { FX_SCALE } from '../../src/domain/money.js';
import type { NewReserveFact } from '../../src/db/stores/facts.js';

/**
 * Tenant isolation, enforced by Postgres row-level security.
 *
 * The threat: a store method that omits an `issuer_id` predicate. `getPeriod(id)`
 * and the various `get(id)` methods take a bare id by design, so nothing in the
 * application layer stops one issuer reading another's reserve positions. These
 * tests exercise exactly those unscoped methods and prove the database refuses
 * anyway.
 *
 * Everything here runs as `reserveos_app`. The harness's own connection is a
 * superuser and bypasses RLS, which is why an explicit role switch is required —
 * without it these tests would pass no matter what the policies said.
 */

const available = await databaseAvailable();

const OTHER_ISSUER = '99999999-9999-9999-9999-999999999999';
const OTHER_CUSTODIAN = '99999999-9999-9999-9999-999999999991';
const OTHER_DEPLOYMENT = '99999999-9999-9999-9999-999999999992';

const AS_OF = new Date('2026-03-31T20:00:00.000Z');
const PERIOD_END = new Date('2026-03-31T23:59:59.999Z');

function reserveFact(issuerId: string, custodianId: string, cents: bigint): NewReserveFact {
  return {
    issuerId,
    custodianId,
    asOf: AS_OF,
    observedAt: AS_OF,
    instrumentCategory: 'CASH',
    cusip: null,
    currency: 'USD',
    faceValueMinor: cents,
    marketValueMinor: cents,
    maturityDate: null,
    sourceHash: 'a'.repeat(64),
  };
}

/** Seed a second, unrelated issuer with its own data. */
async function seedOtherTenant(): Promise<void> {
  const pool = testPool();
  await pool.query(
    `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
     VALUES ($1, 'Rival Trust Co', 'NYDFS', 'env-rival')`,
    [OTHER_ISSUER],
  );
  await pool.query(
    `INSERT INTO custodians (id, issuer_id, name, jurisdiction, connector_type, connector_config)
     VALUES ($1, $2, 'Rival Custodian', 'GB', 'sftp_csv', '{}')`,
    [OTHER_CUSTODIAN, OTHER_ISSUER],
  );
  await pool.query(
    `INSERT INTO token_deployments
       (id, issuer_id, chain_id, contract_address, symbol, decimals, kaleido_connector_id, active)
     VALUES ($1, $2, 137, '0xcccc000000000000000000000000000000000003', 'RIVAL', 6, 'conn-poly', TRUE)`,
    [OTHER_DEPLOYMENT, OTHER_ISSUER],
  );

  await new PgReserveFactStore(pool).insertMany([
    reserveFact(OTHER_ISSUER, OTHER_CUSTODIAN, 777_000_00n),
  ]);
  await new PgSupplyFactStore(pool).insert({
    tokenDeploymentId: OTHER_DEPLOYMENT,
    blockNumber: 500n,
    blockTimestamp: AS_OF,
    totalSupply: 777_000_000_000n,
    observedAt: AS_OF,
  });
}

/** Run `fn` as `reserveos_app` scoped to `issuerId`, so RLS actually applies. */
async function asTenant<T>(
  issuerId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE reserveos_app');
    await client.query('SELECT set_config($1, $2, true)', ['app.issuer_id', issuerId]);
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** As `reserveos_app` with no tenant set at all. */
async function asUnscopedApp<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE reserveos_app');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } finally {
    client.release();
  }
}

describe.skipIf(!available)('tenant isolation', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await seedOtherTenant();

    // Our own tenant's holdings.
    await new PgReserveFactStore(testPool()).insertMany([
      reserveFact(SEED_IDS.issuerId, SEED_IDS.bny, 100_000_00n),
      reserveFact(SEED_IDS.issuerId, SEED_IDS.stateStreet, 250_000_00n),
    ]);
  });

  it('hides another tenant reserve facts', async () => {
    const facts = await asTenant(SEED_IDS.issuerId, (client) =>
      new PgReserveFactStore(client).listAllForIssuer(SEED_IDS.issuerId),
    );
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.issuerId === SEED_IDS.issuerId)).toBe(true);
  });

  it('returns nothing when a tenant asks for another tenant data by id', async () => {
    // Deliberately passing the OTHER issuer's id — the application-layer filter
    // would happily comply. The database is what refuses.
    const facts = await asTenant(SEED_IDS.issuerId, (client) =>
      new PgReserveFactStore(client).listAllForIssuer(OTHER_ISSUER),
    );
    expect(facts).toEqual([]);
  });

  it('refuses an unscoped id lookup across tenants, which is the real hole', async () => {
    // `getPeriod` takes a bare id with no issuer filter. This is the exact
    // method flagged as a cross-tenant read risk.
    const store = new PgReportStore(testPool());
    const otherPeriod = await store.openPeriod(
      OTHER_ISSUER,
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-31T00:00:00.000Z'),
    );

    const seen = await asTenant(SEED_IDS.issuerId, (client) =>
      new PgReportStore(client).getPeriod(otherPeriod.id),
    );

    expect(seen).toBeNull();
  });

  it('scopes custodians and token deployments', async () => {
    const { custodians, deployments } = await asTenant(SEED_IDS.issuerId, async (client) => ({
      custodians: await new PgCustodianStore(client).listForIssuer(SEED_IDS.issuerId),
      deployments: await new PgTokenDeploymentStore(client).listForIssuer(SEED_IDS.issuerId),
    }));

    expect(custodians).toHaveLength(3);
    expect(custodians.map((c) => c.name)).not.toContain('Rival Custodian');
    expect(deployments).toHaveLength(2);
    expect(deployments.map((d) => d.chainId)).not.toContain(137);
  });

  it('scopes supply facts through their deployment, which carries no issuer column', async () => {
    const facts = await asTenant(SEED_IDS.issuerId, (client) =>
      new PgSupplyFactStore(client).listForIssuerAsOf(SEED_IDS.issuerId, PERIOD_END),
    );
    expect(facts.every((f) => f.tokenDeploymentId !== OTHER_DEPLOYMENT)).toBe(true);
  });

  it('scopes report versions through their period', async () => {
    const owner = new PgReportStore(testPool());
    const otherPeriod = await owner.openPeriod(
      OTHER_ISSUER,
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-02-28T00:00:00.000Z'),
    );
    const otherVersion = await owner.insertVersion({
      periodId: otherPeriod.id,
      payload: { secret: 'rival reserves' },
      payloadHash: 'f'.repeat(64),
      generatedAt: AS_OF,
      generatedBy: OTHER_ISSUER,
    });

    const [byHash, byPeriod] = await asTenant(SEED_IDS.issuerId, async (client) => {
      const store = new PgReportStore(client);
      return [await store.findByHash('f'.repeat(64)), await store.listVersions(otherPeriod.id)];
    });

    // Lookup by hash is how an examiner verifies a report; it must not become a
    // cross-tenant read oracle.
    expect(byHash).toBeNull();
    expect(byPeriod).toEqual([]);
    expect(otherVersion.id).toBeTruthy();
  });

  it('sees nothing at all when no tenant is set, failing closed', async () => {
    const counts = await asUnscopedApp(async (client) => {
      const { rows } = await client.query<{ facts: string; custodians: string }>(
        `SELECT (SELECT count(*) FROM reserve_facts)::text AS facts,
                (SELECT count(*) FROM custodians)::text  AS custodians`,
      );
      return rows[0]!;
    });

    // An unset `app.issuer_id` yields NULL, and `issuer_id = NULL` is never true.
    expect(counts.facts).toBe('0');
    expect(counts.custodians).toBe('0');
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      asTenant(SEED_IDS.issuerId, (client) =>
        new PgReserveFactStore(client).insertMany([
          reserveFact(OTHER_ISSUER, OTHER_CUSTODIAN, 1_000_00n),
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('still allows a tenant to write its own rows', async () => {
    const result = await asTenant(SEED_IDS.issuerId, (client) =>
      new PgReserveFactStore(client).insertMany([
        reserveFact(SEED_IDS.issuerId, SEED_IDS.euroclear, 5_000_00n),
      ]),
    );
    expect(result.inserted).toHaveLength(1);
  });

  it('keeps FX rates shared, since a published rate is not private data', async () => {
    await new PgFxRateStore(testPool()).recordMany(
      AS_OF,
      'ECB',
      new Map([['EUR', 108_520_000n]]),
    );

    // Both tenants must convert EUR on the same date using the same figure;
    // partitioning market data per tenant would let two reports disagree about a
    // public exchange rate.
    for (const tenant of [SEED_IDS.issuerId, OTHER_ISSUER]) {
      const rates = await asTenant(tenant, (client) =>
        new PgFxRateStore(client).ratesAsOf(PERIOD_END, 'ECB'),
      );
      expect(rates.ratesToUsd.get('EUR')).toBe(108_520_000n);
      expect(rates.ratesToUsd.get('USD')).toBe(FX_SCALE);
    }
  });

  it('confines the tenant setting to its transaction, so a pooled connection cannot leak it', async () => {
    await withTenant(testPool(), SEED_IDS.issuerId, async (client) => {
      const { rows } = await client.query<{ v: string | null }>(
        `SELECT current_setting('app.issuer_id', true) AS v`,
      );
      expect(rows[0]!.v).toBe(SEED_IDS.issuerId);
    });

    // Same pool, likely the same physical connection, new transaction.
    const { rows } = await testPool().query<{ v: string | null }>(
      `SELECT current_setting('app.issuer_id', true) AS v`,
    );
    expect(rows[0]!.v === null || rows[0]!.v === '').toBe(true);
  });

  it('rejects a malformed issuer id before it reaches a query', async () => {
    await expect(
      withTenant(testPool(), 'not-a-uuid', async () => undefined),
    ).rejects.toThrow(TypeError);
  });

  it('leaves the superuser path unrestricted for migrations and cross-tenant sweeps', async () => {
    // The harness connection is a superuser and bypasses RLS by design.
    const all = await new PgReserveFactStore(testPool()).listAllForIssuer(OTHER_ISSUER);
    expect(all).toHaveLength(1);
  });
});
