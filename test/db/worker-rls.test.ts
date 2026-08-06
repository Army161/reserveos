import { beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  appPool,
  databaseAvailable,
  resetDatabase,
  seedTenant,
  testPool,
  SEED_IDS,
} from './harness.js';
import { InMemoryStatementSource } from '../../src/ingest/source.js';
import { StatementIngestionWorker, type CustodianFeed } from '../../src/ingest/statement-worker.js';
import { SupplyObservationWorker } from '../../src/ingest/supply-worker.js';
import { PgReserveFactStore, PgSupplyFactStore } from '../../src/db/stores/facts.js';
import { FakeKaleidoClient } from '../../src/kaleido/fake.js';
import type { StatementMapping } from '../../src/ingest/mapping.js';
import type { TokenDeployment } from '../../src/domain/types.js';

/**
 * The workers under real row-level security.
 *
 * Everything else in the suite connects as a superuser, which bypasses RLS —
 * so the workers would appear to function even if they never set
 * `app.issuer_id`, and would then write nothing at all in production. These
 * tests run through an unprivileged login role so the policies actually bind.
 */

const available = await databaseAvailable();
const NOW = new Date('2026-04-01T09:00:00.000Z');

const MAPPING: StatementMapping = {
  columns: { category: 'Asset Type', marketValue: 'Market Value', maturityDate: 'Maturity' },
  dateFormat: 'ISO',
  defaultCurrency: 'USD',
};

const STATEMENT = [
  'Asset Type,Market Value,Maturity,Statement Date',
  '"Demand Deposit","2,000,000.00",,2026-03-31',
  '"US Treasury Bill","5,000,000.00",2026-05-15,2026-03-31',
  '',
].join('\n');

describe.skipIf(!available)('ingestion under row-level security', () => {
  let app: pg.Pool;
  let source: InMemoryStatementSource;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    app = await appPool();
    source = new InMemoryStatementSource('bny');
  });

  function feed(): CustodianFeed {
    return {
      issuerId: SEED_IDS.issuerId,
      custodianId: SEED_IDS.bny,
      source,
      mapping: MAPPING,
      statementDate: { kind: 'column', column: 'Statement Date' },
    };
  }

  it('confirms the app connection is genuinely subject to RLS', async () => {
    // Guards the guard: if this role ever gained BYPASSRLS or ownership, every
    // other assertion in this file would silently stop testing anything.
    const { rows } = await app.query<{ current_user: string; bypass: boolean }>(
      `SELECT current_user, bool_or(rolbypassrls) AS bypass
         FROM pg_roles WHERE rolname = current_user GROUP BY current_user`,
    );
    expect(rows[0]!.current_user).toBe('reserveos_test_login');
    expect(rows[0]!.bypass).toBe(false);

    // And with no tenant set it sees nothing.
    const { rows: counted } = await app.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM custodians`,
    );
    expect(counted[0]!.n).toBe('0');
  });

  it('ingests a statement end to end through an RLS-bound connection', async () => {
    source.add('bny-2026-03-31.csv', STATEMENT);

    const worker = new StatementIngestionWorker({ pool: app, now: () => NOW });
    const [outcome] = await worker.run(feed());

    // This is the assertion that would fail if the worker used a bare
    // transaction instead of `withTenant`: the policy would filter every write
    // and the statement would vanish without error.
    expect(outcome!.status).toBe('INGESTED');
    expect(outcome!.factsInserted).toBe(2);

    const facts = await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId);
    expect(facts).toHaveLength(2);
    expect(facts.reduce((sum, f) => sum + f.marketValueMinor, 0n)).toBe(700_000_000n);
  });

  it('records source-document lineage through the same connection', async () => {
    source.add('bny.csv', STATEMENT);
    const worker = new StatementIngestionWorker({ pool: app, now: () => NOW });
    const [outcome] = await worker.run(feed());

    expect(outcome!.documentId).not.toBeNull();
    const { rows } = await testPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_documents WHERE issuer_id = $1`,
      [SEED_IDS.issuerId],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('records a rejected document through the same connection', async () => {
    source.add('bad.csv', 'Asset Type,Market Value,Statement Date\n"Gold Bar","1.00",2026-03-31\n');
    const worker = new StatementIngestionWorker({ pool: app, now: () => NOW });
    const [outcome] = await worker.run(feed());

    expect(outcome!.status).toBe('REJECTED');
    const { rows } = await testPool().query<{ status: string }>(
      `SELECT status FROM source_documents WHERE issuer_id = $1`,
      [SEED_IDS.issuerId],
    );
    expect(rows[0]!.status).toBe('REJECTED');
  });

  it('polls and records token supply through an RLS-bound connection', async () => {
    const kaleido = new FakeKaleidoClient();
    kaleido.setSupply('0xaaaa000000000000000000000000000000000001', {
      totalSupply: 7_000_000_000_000n,
      blockNumber: 21_500_000n,
      blockTimestamp: new Date('2026-03-31T23:50:00.000Z'),
    });
    kaleido.setSupply('0xbbbb000000000000000000000000000000000002', {
      totalSupply: 3_000_000_000_000n,
      blockNumber: 12_000_000n,
      blockTimestamp: new Date('2026-03-31T23:50:00.000Z'),
    });

    const worker = new SupplyObservationWorker({
      pool: app,
      kaleido,
      now: () => NOW,
      connectorIdFor: (d: TokenDeployment) => `conn-${d.chainId}`,
    });

    const outcomes = await worker.run(SEED_IDS.issuerId);

    // `run` must see the deployments at all — a missing tenant setting would
    // return an empty list and the worker would report success having done
    // nothing, leaving a CRITICAL breach at period end.
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === 'RECORDED')).toBe(true);

    const facts = await new PgSupplyFactStore(testPool()).listForIssuerAsOf(
      SEED_IDS.issuerId,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(facts).toHaveLength(2);
  });
});
