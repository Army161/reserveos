import { beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';
import {
  PgFxRateStore,
  PgReserveFactStore,
  PgSupplyFactStore,
  ConflictingSupplyObservationError,
  type NewReserveFact,
} from '../../src/db/stores/facts.js';
import { selectFactsAsOf } from '../../src/domain/reconciliation.js';
import { FX_SCALE } from '../../src/domain/money.js';
import type { InstrumentCategory } from '../../src/domain/types.js';

const available = await databaseAvailable();

const OBSERVED_AT = new Date('2026-04-01T09:00:00.000Z');
const SOURCE_HASH = 'a'.repeat(64);

interface FactOverrides {
  readonly custodianId?: string;
  readonly asOf?: Date;
  readonly instrumentCategory?: InstrumentCategory;
  readonly cusip?: string | null;
  readonly currency?: string;
  readonly faceValueMinor?: bigint;
  readonly marketValueMinor?: bigint;
  readonly maturityDate?: Date | null;
}

function fact(overrides: FactOverrides = {}): NewReserveFact {
  return {
    issuerId: SEED_IDS.issuerId,
    custodianId: overrides.custodianId ?? SEED_IDS.bny,
    asOf: overrides.asOf ?? new Date('2026-03-31T12:00:00.000Z'),
    observedAt: OBSERVED_AT,
    instrumentCategory: overrides.instrumentCategory ?? 'TBILL',
    cusip: overrides.cusip === undefined ? '912797KL5' : overrides.cusip,
    currency: overrides.currency ?? 'USD',
    faceValueMinor: overrides.faceValueMinor ?? 100_000_00n,
    marketValueMinor: overrides.marketValueMinor ?? 99_850_00n,
    maturityDate:
      overrides.maturityDate === undefined
        ? new Date('2026-05-15T00:00:00.000Z')
        : overrides.maturityDate,
    sourceHash: SOURCE_HASH,
  };
}

describe.skipIf(!available)('PgReserveFactStore', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  it('round-trips every field, including values beyond Number.MAX_SAFE_INTEGER', async () => {
    const store = new PgReserveFactStore(testPool());

    // Both exceed 2^53, so a `number` anywhere in the path would silently
    // corrupt the figure. face is near the BIGINT ceiling on purpose.
    const face = 9_223_372_036_854_775_806n;
    const market = 9_007_199_254_740_993n;

    const input = fact({
      custodianId: SEED_IDS.euroclear,
      currency: 'EUR',
      faceValueMinor: face,
      marketValueMinor: market,
      instrumentCategory: 'REPO',
      cusip: null,
      maturityDate: null,
    });

    const { inserted, skipped } = await store.insertMany([input]);
    expect(skipped).toBe(0);
    expect(inserted).toHaveLength(1);

    const written = inserted[0]!;
    expect(written.issuerId).toBe(SEED_IDS.issuerId);
    expect(written.custodianId).toBe(SEED_IDS.euroclear);
    expect(written.asOf.toISOString()).toBe('2026-03-31T12:00:00.000Z');
    expect(written.observedAt.toISOString()).toBe(OBSERVED_AT.toISOString());
    expect(written.instrumentCategory).toBe('REPO');
    expect(written.cusip).toBeNull();
    expect(written.currency).toBe('EUR');
    expect(written.faceValueMinor).toBe(face);
    expect(written.marketValueMinor).toBe(market);
    expect(written.maturityDate).toBeNull();
    expect(written.sourceHash).toBe(SOURCE_HASH);
    expect(written.supersededBy).toBeNull();
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/);

    // Re-read: the values must survive the wire, not merely the RETURNING clause.
    const [reread] = await store.listAllForIssuer(SEED_IDS.issuerId);
    expect(reread).toEqual(written);
  });

  it('keeps a maturity date on the same UTC calendar day', async () => {
    const store = new PgReserveFactStore(testPool());
    const maturity = new Date('2026-05-15T00:00:00.000Z');

    const { inserted } = await store.insertMany([fact({ maturityDate: maturity })]);

    // The local-midnight bug guard: a DATE written as a raw JS Date shifts a day
    // on hosts east of UTC, flipping a 93-day-boundary instrument in or out of
    // breach depending on where the server runs.
    expect(inserted[0]!.maturityDate?.toISOString()).toBe('2026-05-15T00:00:00.000Z');

    const [reread] = await store.listAllForIssuer(SEED_IDS.issuerId);
    expect(reread!.maturityDate?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(reread!.maturityDate?.getUTCDate()).toBe(15);
  });

  it('inserts a multi-line statement in one statement', async () => {
    const store = new PgReserveFactStore(testPool());

    const lines = [
      fact({ cusip: '912797KL5', marketValueMinor: 1_000_00n }),
      fact({ cusip: '912797KM3', marketValueMinor: 2_000_00n }),
      fact({ cusip: null, instrumentCategory: 'CASH', marketValueMinor: 3_000_00n }),
    ];

    const { inserted, skipped } = await store.insertMany(lines);
    expect(inserted).toHaveLength(3);
    expect(skipped).toBe(0);
    expect(new Set(inserted.map((f) => f.id)).size).toBe(3);
  });

  it('treats re-ingestion of an identical statement as a no-op', async () => {
    const store = new PgReserveFactStore(testPool());

    const lines = [
      fact({ cusip: '912797KL5', marketValueMinor: 1_000_00n }),
      fact({ cusip: null, instrumentCategory: 'CASH', marketValueMinor: 3_000_00n }),
    ];

    const first = await store.insertMany(lines);
    expect(first.inserted).toHaveLength(2);
    expect(first.skipped).toBe(0);

    // A replayed SFTP drop: same lines, later ingestion clock.
    const replay = lines.map((line) => ({
      ...line,
      observedAt: new Date('2026-04-02T09:00:00.000Z'),
    }));
    const second = await store.insertMany(replay);
    expect(second.inserted).toHaveLength(0);
    expect(second.skipped).toBe(2);

    expect(await store.listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(2);
  });

  it('counts partial overlap correctly when a statement gains a line', async () => {
    const store = new PgReserveFactStore(testPool());

    const original = fact({ cusip: '912797KL5', marketValueMinor: 1_000_00n });
    await store.insertMany([original]);

    const result = await store.insertMany([
      original,
      fact({ cusip: '912797KM3', marketValueMinor: 2_000_00n }),
    ]);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toHaveLength(1);
    expect(result.inserted[0]!.cusip).toBe('912797KM3');
  });

  it('returns every line of the latest statement, not one row per custodian', async () => {
    const store = new PgReserveFactStore(testPool());
    const asOf = new Date('2026-03-31T23:59:59.999Z');
    const latest = new Date('2026-03-31T12:00:00.000Z');

    await store.insertMany([
      fact({ asOf: new Date('2026-03-30T12:00:00.000Z'), marketValueMinor: 500_00n }),
      fact({ asOf: latest, cusip: 'AAA', marketValueMinor: 1_000_00n }),
      fact({ asOf: latest, cusip: 'BBB', marketValueMinor: 2_000_00n }),
      fact({ asOf: latest, cusip: 'CCC', marketValueMinor: 3_000_00n }),
      fact({
        custodianId: SEED_IDS.stateStreet,
        asOf: new Date('2026-03-29T12:00:00.000Z'),
        cusip: 'DDD',
        marketValueMinor: 4_000_00n,
      }),
    ]);

    const current = await store.listCurrentAsOf(SEED_IDS.issuerId, asOf);

    expect(current).toHaveLength(4);
    const bny = current.filter((f) => f.custodianId === SEED_IDS.bny);
    expect(bny).toHaveLength(3);
    expect(bny.map((f) => f.cusip).sort()).toEqual(['AAA', 'BBB', 'CCC']);
    // The superseded-by-recency line from the 30th must not leak into the total.
    expect(current.reduce((sum, f) => sum + f.marketValueMinor, 0n)).toBe(10_000_00n);
  });

  it('excludes superseded rows and rows dated after the period end', async () => {
    const store = new PgReserveFactStore(testPool());
    const asOf = new Date('2026-03-31T23:59:59.999Z');

    const { inserted } = await store.insertMany([
      fact({ cusip: 'AAA', marketValueMinor: 1_000_00n }),
      fact({ cusip: 'BBB', marketValueMinor: 2_000_00n }),
      fact({
        custodianId: SEED_IDS.euroclear,
        asOf: new Date('2026-04-02T12:00:00.000Z'),
        cusip: 'FUTURE',
        marketValueMinor: 9_000_00n,
      }),
    ]);

    const wrong = inserted.find((f) => f.cusip === 'BBB')!;
    const { inserted: corrections } = await store.insertMany([
      fact({ cusip: 'BBB', marketValueMinor: 2_100_00n }),
    ]);
    await store.supersede(wrong.id, corrections[0]!.id);

    const current = await store.listCurrentAsOf(SEED_IDS.issuerId, asOf);
    expect(current.map((f) => f.cusip).sort()).toEqual(['AAA', 'BBB']);
    expect(current.map((f) => f.marketValueMinor).reduce((a, b) => a + b, 0n)).toBe(3_100_00n);

    // History keeps everything, including the retracted line and the future one.
    expect(await store.listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(4);
  });

  it('falls back to the previous statement when the latest one is fully retracted', async () => {
    const store = new PgReserveFactStore(testPool());
    const asOf = new Date('2026-03-31T23:59:59.999Z');

    const { inserted } = await store.insertMany([
      fact({
        custodianId: SEED_IDS.stateStreet,
        asOf: new Date('2026-03-29T12:00:00.000Z'),
        cusip: 'GOOD',
        marketValueMinor: 5_000_00n,
      }),
      fact({
        custodianId: SEED_IDS.stateStreet,
        asOf: new Date('2026-03-30T12:00:00.000Z'),
        cusip: 'BOGUS',
        marketValueMinor: 6_000_00n,
      }),
    ]);

    const good = inserted.find((f) => f.cusip === 'GOOD')!;
    const bogus = inserted.find((f) => f.cusip === 'BOGUS')!;
    // The 30th's statement was sent in error; the position reverts to the 29th.
    await store.supersede(bogus.id, good.id);

    const current = await store.listCurrentAsOf(SEED_IDS.issuerId, asOf);
    expect(current.map((f) => f.cusip)).toEqual(['GOOD']);
    expect(current[0]!.asOf.toISOString()).toBe('2026-03-29T12:00:00.000Z');
  });

  it('throws when superseding a fact that does not exist', async () => {
    const store = new PgReserveFactStore(testPool());
    const { inserted } = await store.insertMany([fact()]);

    await expect(
      store.supersede('44444444-4444-4444-4444-444444444444', inserted[0]!.id),
    ).rejects.toThrow(/not found/);
  });

  it('refuses to rewrite an existing supersession', async () => {
    const store = new PgReserveFactStore(testPool());
    const { inserted } = await store.insertMany([
      fact({ cusip: 'AAA', marketValueMinor: 1_000_00n }),
      fact({ cusip: 'BBB', marketValueMinor: 2_000_00n }),
      fact({ cusip: 'CCC', marketValueMinor: 3_000_00n }),
    ]);
    const original = inserted.find((f) => f.cusip === 'AAA')!;
    const correction = inserted.find((f) => f.cusip === 'BBB')!;
    const later = inserted.find((f) => f.cusip === 'CCC')!;

    await store.supersede(original.id, correction.id);

    // Retracting the same fact twice would repoint the lineage and erase the fact
    // that `correction` ever replaced it. Two concurrent callers hit this same
    // predicate, so exactly one supersession can ever win.
    await expect(store.supersede(original.id, later.id)).rejects.toThrow(/already superseded/);

    // Re-read: the pointer must still be the first correction, not the second.
    const all = await store.listAllForIssuer(SEED_IDS.issuerId);
    expect(all.find((f) => f.id === original.id)!.supersededBy).toBe(correction.id);
  });

  it('counts a line repeated inside one batch as skipped', async () => {
    const store = new PgReserveFactStore(testPool());
    const line = fact({ cusip: '912797KL5', marketValueMinor: 1_000_00n });

    // A custodian file that repeats a line must not create two holdings: the
    // dedupe index has to fire *within* one statement, not only across calls.
    const { inserted, skipped } = await store.insertMany([line, line]);
    expect(inserted).toHaveLength(1);
    expect(skipped).toBe(1);
    expect(await store.listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(1);
  });

  it('refuses a batch that would exceed the Postgres bind-parameter limit', async () => {
    const store = new PgReserveFactStore(testPool());

    // 65535 bind parameters / 11 per row = 5957 rows. One more must be refused up
    // front, not fail deep in the wire protocol with a message about parameters.
    const oversized = Array.from({ length: 5958 }, (_, i) => fact({ cusip: `X${i}` }));

    await expect(store.insertMany(oversized)).rejects.toThrow(RangeError);
    // Nothing may be partially written by a refused batch.
    expect(await store.listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(0);
  });

  it('is a no-op for an empty batch', async () => {
    const store = new PgReserveFactStore(testPool());
    expect(await store.insertMany([])).toEqual({ inserted: [], skipped: 0 });
  });

  /**
   * The load-bearing test. `listCurrentAsOf` pushes the position-selection rule
   * into SQL for speed; `selectFactsAsOf` is the authoritative pure statement of
   * that rule. If they ever disagree, reserves are misstated on a certified
   * report — so assert they agree on a deliberately nasty fact set.
   */
  it('narrows identically to selectFactsAsOf', async () => {
    const store = new PgReserveFactStore(testPool());
    const asOf = new Date('2026-03-31T23:59:59.999Z');

    const { inserted } = await store.insertMany([
      // BNY: superseded statement date, then the live one.
      fact({ asOf: new Date('2026-03-28T12:00:00.000Z'), cusip: 'B-OLD-1', marketValueMinor: 10n }),
      fact({ asOf: new Date('2026-03-28T12:00:00.000Z'), cusip: 'B-OLD-2', marketValueMinor: 20n }),
      fact({ asOf: new Date('2026-03-31T06:00:00.000Z'), cusip: 'B-NEW-1', marketValueMinor: 30n }),
      fact({ asOf: new Date('2026-03-31T06:00:00.000Z'), cusip: 'B-NEW-2', marketValueMinor: 40n }),
      fact({
        asOf: new Date('2026-03-31T06:00:00.000Z'),
        cusip: 'B-NEW-3',
        marketValueMinor: 50n,
      }),
      // State Street: latest statement lands after the period end.
      fact({
        custodianId: SEED_IDS.stateStreet,
        asOf: new Date('2026-03-27T12:00:00.000Z'),
        cusip: 'S-1',
        marketValueMinor: 60n,
      }),
      fact({
        custodianId: SEED_IDS.stateStreet,
        asOf: new Date('2026-04-05T12:00:00.000Z'),
        cusip: 'S-FUTURE',
        marketValueMinor: 70n,
      }),
      // Euroclear: everything it has is after the period end.
      fact({
        custodianId: SEED_IDS.euroclear,
        asOf: new Date('2026-04-01T12:00:00.000Z'),
        cusip: 'E-1',
        currency: 'EUR',
        marketValueMinor: 80n,
      }),
    ]);

    // A correction inside the live BNY statement.
    const wrong = inserted.find((f) => f.cusip === 'B-NEW-3')!;
    const { inserted: corrections } = await store.insertMany([
      fact({ asOf: new Date('2026-03-31T06:00:00.000Z'), cusip: 'B-NEW-3', marketValueMinor: 55n }),
    ]);
    await store.supersede(wrong.id, corrections[0]!.id);

    // Compare the SQL result DIRECTLY against the domain rule. Feeding the SQL
    // output back through selectFactsAsOf would let the domain function repair an
    // over-broad query — precisely the bug this test exists to catch — and the
    // comparison would still pass. (Verified: with the latest-statement join
    // deleted from listCurrentAsOf entirely, the re-narrowed form of this test
    // still passed.) Both sides are ordered by id ascending — Postgres uuid order
    // and JS string order agree on canonical lowercase UUIDs — so deep equality
    // over the whole array, order included, is the right assertion.
    const viaSql = await store.listCurrentAsOf(SEED_IDS.issuerId, asOf);
    const viaDomain = selectFactsAsOf(await store.listAllForIssuer(SEED_IDS.issuerId), asOf);

    expect(viaSql).toEqual(viaDomain);
    // Guard against both sides being vacuously empty.
    expect(viaDomain.map((f) => f.cusip)).toEqual(
      expect.arrayContaining(['B-NEW-1', 'B-NEW-2', 'B-NEW-3', 'S-1']),
    );
    expect(viaDomain).toHaveLength(4);
    expect(viaDomain.reduce((sum, f) => sum + f.marketValueMinor, 0n)).toBe(185n);
  });
});

describe.skipIf(!available)('PgSupplyFactStore', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  const supply = {
    tokenDeploymentId: SEED_IDS.ethereum,
    blockNumber: 21_500_000n,
    blockTimestamp: new Date('2026-03-31T23:59:00.000Z'),
    totalSupply: 5_000_000_000_000n,
    observedAt: new Date('2026-04-01T00:05:00.000Z'),
  };

  it('round-trips a uint256-scale supply exactly', async () => {
    const store = new PgSupplyFactStore(testPool());
    // 10 billion tokens at 18 decimals — ~1e28, far past Number.MAX_SAFE_INTEGER.
    const huge = 10_000_000_000n * 10n ** 18n;

    const written = await store.insert({ ...supply, totalSupply: huge });
    expect(written).not.toBeNull();
    expect(written!.totalSupply).toBe(huge);
    expect(written!.blockNumber).toBe(21_500_000n);
    expect(written!.blockTimestamp.toISOString()).toBe('2026-03-31T23:59:00.000Z');
    expect(written!.observedAt.toISOString()).toBe('2026-04-01T00:05:00.000Z');
    expect(written!.tokenDeploymentId).toBe(SEED_IDS.ethereum);

    const [reread] = await store.listForIssuerAsOf(
      SEED_IDS.issuerId,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(reread).toEqual(written);
  });

  it('returns null when the same block is re-observed with the same supply', async () => {
    const store = new PgSupplyFactStore(testPool());

    expect(await store.insert(supply)).not.toBeNull();
    // An indexer re-scan is not new data, and must not double-count outstanding.
    expect(await store.insert({ ...supply })).toBeNull();

    const all = await store.listForIssuerAsOf(
      SEED_IDS.issuerId,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.totalSupply).toBe(supply.totalSupply);
  });

  it('refuses a contradictory supply at an already-observed block', async () => {
    const store = new PgSupplyFactStore(testPool());
    await store.insert(supply);

    // Two different supplies at one block means a reorg replaced history or the
    // indexer is wrong. Outstanding supply is the denominator of the
    // collateralization ratio, so keeping whichever landed first would put an
    // unverifiable number on a certified report.
    await expect(store.insert({ ...supply, totalSupply: 999n })).rejects.toThrow(
      ConflictingSupplyObservationError,
    );

    const all = await store.listForIssuerAsOf(
      SEED_IDS.issuerId,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.totalSupply).toBe(supply.totalSupply);
  });

  it('filters by issuer and by block timestamp', async () => {
    const store = new PgSupplyFactStore(testPool());

    await store.insert(supply);
    await store.insert({
      ...supply,
      tokenDeploymentId: SEED_IDS.base,
      blockNumber: 9_100_000n,
      totalSupply: 7_000_000_000_000n,
    });
    await store.insert({
      ...supply,
      blockNumber: 21_600_000n,
      blockTimestamp: new Date('2026-04-01T12:00:00.000Z'),
      totalSupply: 8_000_000_000_000n,
    });

    const asOf = new Date('2026-03-31T23:59:59.999Z');
    const selected = await store.listForIssuerAsOf(SEED_IDS.issuerId, asOf);

    expect(selected).toHaveLength(2);
    expect(selected.every((f) => f.blockTimestamp.getTime() <= asOf.getTime())).toBe(true);
    expect(selected.map((f) => f.id)).toEqual([...selected.map((f) => f.id)].sort());

    const other = await store.listForIssuerAsOf(
      '11111111-1111-1111-1111-111111111112',
      new Date('2026-05-01T00:00:00.000Z'),
    );
    expect(other).toEqual([]);
  });
});

describe.skipIf(!available)('PgFxRateStore', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  const march1 = new Date('2026-03-01T00:00:00.000Z');
  const march15 = new Date('2026-03-15T00:00:00.000Z');

  it('picks the most recent rate per currency at or before the date', async () => {
    const store = new PgFxRateStore(testPool());

    await store.recordMany(
      march1,
      'ECB',
      new Map([
        ['EUR', 108_000_000n],
        ['GBP', 126_000_000n],
      ]),
    );
    // Only EUR is requoted; GBP must still resolve, from the older row.
    await store.recordMany(march15, 'ECB', new Map([['EUR', 109_250_000n]]));

    const later = await store.ratesAsOf(new Date('2026-03-31T23:59:59.999Z'), 'ECB');
    expect(later.ratesToUsd.get('EUR')).toBe(109_250_000n);
    expect(later.ratesToUsd.get('GBP')).toBe(126_000_000n);
    expect(later.asOf.toISOString()).toBe('2026-03-31T23:59:59.999Z');
    expect(later.source).toBe('ECB');

    // As at the 10th the requote has not happened yet.
    const earlier = await store.ratesAsOf(new Date('2026-03-10T00:00:00.000Z'), 'ECB');
    expect(earlier.ratesToUsd.get('EUR')).toBe(108_000_000n);

    // Before any quote exists, the currency is simply absent — a missing rate is
    // a CRITICAL breach upstream, never a silent 1:1 conversion.
    const before = await store.ratesAsOf(new Date('2026-02-01T00:00:00.000Z'), 'ECB');
    expect(before.ratesToUsd.has('EUR')).toBe(false);
  });

  it('always reports USD as exactly the FX scale', async () => {
    const store = new PgFxRateStore(testPool());

    const empty = await store.ratesAsOf(march15, 'ECB');
    expect(empty.ratesToUsd.get('USD')).toBe(FX_SCALE);

    await store.recordMany(march1, 'ECB', new Map([['USD', FX_SCALE]]));
    const stored = await store.ratesAsOf(march15, 'ECB');
    expect(stored.ratesToUsd.get('USD')).toBe(FX_SCALE);
  });

  it('rejects a corrupt USD quote rather than converting with it', async () => {
    const store = new PgFxRateStore(testPool());
    await store.recordMany(march1, 'ECB', new Map([['USD', 99_000_000n]]));

    await expect(store.ratesAsOf(march15, 'ECB')).rejects.toThrow(/USD must be exactly/);
  });

  it('never overwrites a recorded rate, so a certified report stays reproducible', async () => {
    const store = new PgFxRateStore(testPool());

    await store.recordMany(march1, 'ECB', new Map([['EUR', 108_000_000n]]));
    // A vendor restatement for the same (as_of, source) must not mutate history:
    // recomputing an already-certified report has to reproduce its original hash.
    await store.recordMany(march1, 'ECB', new Map([['EUR', 108_500_000n]]));

    const rates = await store.ratesAsOf(march15, 'ECB');
    expect(rates.ratesToUsd.get('EUR')).toBe(108_000_000n);

    const { rows } = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fx_rates WHERE currency = 'EUR'`,
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('records a correction under a distinct source rather than in place', async () => {
    const store = new PgFxRateStore(testPool());

    await store.recordMany(march1, 'ECB', new Map([['EUR', 108_000_000n]]));
    await store.recordMany(march1, 'ECB-RESTATED', new Map([['EUR', 108_500_000n]]));

    // Both observations survive, and choosing between them is an explicit act.
    expect((await store.ratesAsOf(march15, 'ECB')).ratesToUsd.get('EUR')).toBe(108_000_000n);
    expect((await store.ratesAsOf(march15, 'ECB-RESTATED')).ratesToUsd.get('EUR')).toBe(
      108_500_000n,
    );
  });

  it('records rates using only the privileges the app role actually holds', async () => {
    // `fx_rates` is append-only, so `reserveos_app` has INSERT and SELECT but not
    // UPDATE. Postgres checks UPDATE privilege at PLAN time, so an ON CONFLICT DO
    // UPDATE fails here even when no row actually conflicts. The harness connects
    // as the owner, which is why this needs an explicit role switch — otherwise
    // the failure only ever appears in production.
    const client = await testPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE reserveos_app');
      const store = new PgFxRateStore(client);

      await expect(
        store.recordMany(march1, 'ECB', new Map([['EUR', 108_000_000n]])),
      ).resolves.toBeUndefined();
      // Second call takes the ON CONFLICT path, which is where DO UPDATE failed.
      await expect(
        store.recordMany(march1, 'ECB', new Map([['EUR', 108_000_000n]])),
      ).resolves.toBeUndefined();

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('keeps sources separate', async () => {
    const store = new PgFxRateStore(testPool());

    await store.recordMany(march1, 'ECB', new Map([['EUR', 108_000_000n]]));
    await store.recordMany(march1, 'BLOOMBERG', new Map([['EUR', 108_030_000n]]));

    expect((await store.ratesAsOf(march15, 'ECB')).ratesToUsd.get('EUR')).toBe(108_000_000n);
    expect((await store.ratesAsOf(march15, 'BLOOMBERG')).ratesToUsd.get('EUR')).toBe(108_030_000n);
    expect((await store.ratesAsOf(march15, 'MISSING')).ratesToUsd.has('EUR')).toBe(false);
  });

  it('is a no-op for an empty rate table', async () => {
    const store = new PgFxRateStore(testPool());
    await store.recordMany(march1, 'ECB', new Map());

    const { rows } = await testPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fx_rates`,
    );
    expect(rows[0]!.count).toBe('0');
  });
});
