import { beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';
import {
  PgFxRateStore,
  PgReserveFactStore,
  PgSupplyFactStore,
  type NewReserveFact,
} from '../../src/db/stores/facts.js';
import { PgCustodianStore, PgTokenDeploymentStore } from '../../src/db/stores/reference.js';
import { computePeriod } from '../../src/domain/reconciliation.js';
import { buildReport } from '../../src/domain/report.js';
import { FX_SCALE } from '../../src/domain/money.js';
import type { ComputePeriodInput } from '../../src/domain/reconciliation.js';
import type { PeriodComputation } from '../../src/domain/types.js';

/**
 * The persistence layer must be transparent to the determinism guarantee.
 *
 * `test/determinism.test.ts` proves the pure pipeline is reproducible. This file
 * proves the database does not perturb it: figures written to Postgres and read
 * back must produce the same computation, and reloading must produce the same
 * report hash every time.
 *
 * If this fails, a certified report cannot be regenerated and independently
 * verified months later — which is the entire product. Treat a failure here as a
 * release blocker.
 */

const available = await databaseAvailable();

const PERIOD_START = new Date('2026-03-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-03-31T23:59:59.999Z');
const STATEMENT_AS_OF = new Date('2026-03-31T20:00:00.000Z');
const OBSERVED_AT = new Date('2026-03-31T20:05:00.000Z');
const BLOCK_TIME = new Date('2026-03-31T23:50:00.000Z');
const GENERATED_AT = new Date('2026-04-02T14:30:00.000Z');

const ISSUER = {
  id: SEED_IDS.issuerId,
  legalName: 'Acme Digital Trust Company, N.A.',
  regulator: 'OCC',
};

const REDEMPTIONS = {
  requestCount: 412,
  settledCount: 410,
  breachedCount: 0,
  medianSettlementMinutes: 47,
};

function usd(dollars: number): bigint {
  return BigInt(dollars) * 100n;
}

/** The same holdings the in-memory baseline fixture uses. */
const HOLDINGS: readonly NewReserveFact[] = [
  {
    issuerId: SEED_IDS.issuerId,
    custodianId: SEED_IDS.bny,
    asOf: STATEMENT_AS_OF,
    observedAt: OBSERVED_AT,
    instrumentCategory: 'CASH',
    cusip: null,
    currency: 'USD',
    faceValueMinor: usd(2_000_000),
    marketValueMinor: usd(2_000_000),
    maturityDate: null,
    sourceHash: 'a'.repeat(64),
  },
  {
    issuerId: SEED_IDS.issuerId,
    custodianId: SEED_IDS.bny,
    asOf: STATEMENT_AS_OF,
    observedAt: OBSERVED_AT,
    instrumentCategory: 'TBILL',
    cusip: '912797KL0',
    currency: 'USD',
    faceValueMinor: usd(3_000_000),
    marketValueMinor: usd(3_000_000),
    maturityDate: new Date('2026-05-15T00:00:00.000Z'),
    sourceHash: 'b'.repeat(64),
  },
  {
    issuerId: SEED_IDS.issuerId,
    custodianId: SEED_IDS.stateStreet,
    asOf: STATEMENT_AS_OF,
    observedAt: OBSERVED_AT,
    instrumentCategory: 'TBILL',
    cusip: '912797MM6',
    currency: 'USD',
    faceValueMinor: usd(3_500_000),
    marketValueMinor: usd(3_500_000),
    maturityDate: new Date('2026-06-20T00:00:00.000Z'),
    sourceHash: 'c'.repeat(64),
  },
  {
    issuerId: SEED_IDS.issuerId,
    custodianId: SEED_IDS.euroclear,
    asOf: STATEMENT_AS_OF,
    observedAt: OBSERVED_AT,
    instrumentCategory: 'TBILL',
    cusip: '912797KL0',
    currency: 'USD',
    faceValueMinor: usd(2_000_000),
    marketValueMinor: usd(2_000_000),
    maturityDate: new Date('2026-05-15T00:00:00.000Z'),
    sourceHash: 'd'.repeat(64),
  },
];

async function seedHoldings(): Promise<void> {
  const pool = testPool();
  await new PgReserveFactStore(pool).insertMany(HOLDINGS);

  const supply = new PgSupplyFactStore(pool);
  await supply.insert({
    tokenDeploymentId: SEED_IDS.ethereum,
    blockNumber: 21_500_000n,
    blockTimestamp: BLOCK_TIME,
    totalSupply: 7_000_000_000_000n, // 7,000,000 tokens at 6 decimals
    observedAt: OBSERVED_AT,
  });
  await supply.insert({
    tokenDeploymentId: SEED_IDS.base,
    blockNumber: 12_000_000n,
    blockTimestamp: BLOCK_TIME,
    totalSupply: 3_000_000_000_000n,
    observedAt: OBSERVED_AT,
  });

  await new PgFxRateStore(pool).recordMany(
    STATEMENT_AS_OF,
    'ECB',
    new Map([['USD', FX_SCALE]]),
  );
}

/** Rebuild the engine's inputs entirely from the database. */
async function loadFromDatabase(): Promise<ComputePeriodInput> {
  const pool = testPool();
  return {
    asOf: PERIOD_END,
    facts: await new PgReserveFactStore(pool).listCurrentAsOf(SEED_IDS.issuerId, PERIOD_END),
    supplyFacts: await new PgSupplyFactStore(pool).listForIssuerAsOf(SEED_IDS.issuerId, PERIOD_END),
    deployments: await new PgTokenDeploymentStore(pool).listActiveForIssuer(SEED_IDS.issuerId),
    custodians: await new PgCustodianStore(pool).listForIssuer(SEED_IDS.issuerId),
    fx: await new PgFxRateStore(pool).ratesAsOf(PERIOD_END, 'ECB'),
  };
}

function report(computation: PeriodComputation) {
  return buildReport({
    issuer: ISSUER,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    computation,
    redemptions: REDEMPTIONS,
    fxSource: 'ECB',
    generatedAt: GENERATED_AT,
  });
}

/** The payload minus database-assigned identifiers, which legitimately differ. */
function withoutLineage(payload: unknown): Record<string, unknown> {
  const clone = structuredClone(payload) as Record<string, unknown>;
  delete clone['lineage'];
  return clone;
}

describe.skipIf(!available)('database round trip preserves determinism', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await seedHoldings();
  });

  it('computes identical figures from the database as from memory', async () => {
    const fromDb = computePeriod(await loadFromDatabase());

    // The same holdings, held only in memory.
    const inMemory = computePeriod({
      asOf: PERIOD_END,
      facts: HOLDINGS.map((holding, index) => ({
        ...holding,
        id: `mem-${index}`,
        supersededBy: null,
      })),
      supplyFacts: [
        {
          id: 'mem-s1',
          tokenDeploymentId: SEED_IDS.ethereum,
          blockNumber: 21_500_000n,
          blockTimestamp: BLOCK_TIME,
          totalSupply: 7_000_000_000_000n,
          observedAt: OBSERVED_AT,
        },
        {
          id: 'mem-s2',
          tokenDeploymentId: SEED_IDS.base,
          blockNumber: 12_000_000n,
          blockTimestamp: BLOCK_TIME,
          totalSupply: 3_000_000_000_000n,
          observedAt: OBSERVED_AT,
        },
      ],
      deployments: await new PgTokenDeploymentStore(testPool()).listActiveForIssuer(
        SEED_IDS.issuerId,
      ),
      custodians: await new PgCustodianStore(testPool()).listForIssuer(SEED_IDS.issuerId),
      fx: { asOf: STATEMENT_AS_OF, source: 'ECB', ratesToUsd: new Map([['USD', FX_SCALE]]) },
    });

    expect(fromDb.totalReserveValueMinor).toBe(inMemory.totalReserveValueMinor);
    expect(fromDb.totalOutstandingMinor).toBe(inMemory.totalOutstandingMinor);
    expect(fromDb.collateralizationRatioBps).toBe(inMemory.collateralizationRatioBps);
    expect(fromDb.breaches).toEqual(inMemory.breaches);
    expect([...fromDb.compositionByCategory]).toEqual([...inMemory.compositionByCategory]);
    expect([...fromDb.custodyByJurisdiction]).toEqual([...inMemory.custodyByJurisdiction]);
    expect(fromDb.supplyByChain).toEqual(inMemory.supplyByChain);
  });

  it('produces a byte-identical report payload, ignoring database-assigned ids', async () => {
    const fromDb = report(computePeriod(await loadFromDatabase()));
    const inMemory = report(
      computePeriod({
        asOf: PERIOD_END,
        facts: HOLDINGS.map((holding, index) => ({
          ...holding,
          id: `mem-${index}`,
          supersededBy: null,
        })),
        supplyFacts: [
          {
            id: 'mem-s1',
            tokenDeploymentId: SEED_IDS.ethereum,
            blockNumber: 21_500_000n,
            blockTimestamp: BLOCK_TIME,
            totalSupply: 7_000_000_000_000n,
            observedAt: OBSERVED_AT,
          },
          {
            id: 'mem-s2',
            tokenDeploymentId: SEED_IDS.base,
            blockNumber: 12_000_000n,
            blockTimestamp: BLOCK_TIME,
            totalSupply: 3_000_000_000_000n,
            observedAt: OBSERVED_AT,
          },
        ],
        deployments: await new PgTokenDeploymentStore(testPool()).listActiveForIssuer(
          SEED_IDS.issuerId,
        ),
        custodians: await new PgCustodianStore(testPool()).listForIssuer(SEED_IDS.issuerId),
        fx: { asOf: STATEMENT_AS_OF, source: 'ECB', ratesToUsd: new Map([['USD', FX_SCALE]]) },
      }),
    );

    expect(withoutLineage(fromDb.payload)).toEqual(withoutLineage(inMemory.payload));
  });

  it('reproduces the same report hash on every reload', async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      hashes.add(report(computePeriod(await loadFromDatabase())).payloadHash);
    }
    // A single differing byte anywhere in the read path — a timestamp losing
    // precision, a map iterating in insertion order, a numeric arriving as a
    // float — would show up here as a second hash.
    expect(hashes.size).toBe(1);
  });

  it('keeps the block timestamp exact, since it is serialized into the payload', async () => {
    const computation = computePeriod(await loadFromDatabase());
    for (const chain of computation.supplyByChain) {
      expect(chain.blockTimestamp.toISOString()).toBe(BLOCK_TIME.toISOString());
      expect(chain.blockTimestamp.getTime()).toBe(BLOCK_TIME.getTime());
    }
  });

  it('keeps maturity dates on the correct UTC day after a reload', async () => {
    const facts = await new PgReserveFactStore(testPool()).listCurrentAsOf(
      SEED_IDS.issuerId,
      PERIOD_END,
    );
    const maturities = facts
      .map((f) => f.maturityDate?.toISOString() ?? null)
      .filter((v): v is string => v !== null)
      .sort();

    expect(maturities).toEqual([
      '2026-05-15T00:00:00.000Z',
      '2026-05-15T00:00:00.000Z',
      '2026-06-20T00:00:00.000Z',
    ]);
  });

  it('carries the headline figures the fixture expects', async () => {
    const computation = computePeriod(await loadFromDatabase());

    expect(computation.totalReserveValueMinor).toBe(usd(10_500_000));
    expect(computation.totalOutstandingMinor).toBe(usd(10_000_000));
    expect(computation.collateralizationRatioBps).toBe(10_500);
    expect(computation.breaches).toEqual([]);
    expect(computation.compositionByCategory.get('TBILL')?.weightedAverageTenorDays).toBe('59.82');
  });

  it('detects tampering with a stored reserve value', async () => {
    const before = report(computePeriod(await loadFromDatabase())).payloadHash;

    // Simulate an insider editing a figure directly. The app role cannot do this
    // (002_grants.sql), which is why the harness connects as the owner.
    await testPool().query(
      `UPDATE reserve_facts SET market_value_minor = market_value_minor + 1
        WHERE instrument_category = 'CASH'`,
    );

    const after = report(computePeriod(await loadFromDatabase())).payloadHash;
    expect(after).not.toBe(before);
  });
});
