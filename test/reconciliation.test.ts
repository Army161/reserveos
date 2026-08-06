import { describe, expect, it } from 'vitest';
import { computePeriod, selectFactsAsOf } from '../src/domain/reconciliation.js';
import { DEFAULT_RULE_CONFIG } from '../src/domain/rules.js';
import type { BreachCode } from '../src/domain/types.js';
import {
  baselineScenario,
  CUSTODIANS,
  DEPLOYMENTS,
  fact,
  PERIOD_END,
  rates,
  supply,
} from './fixtures.js';

const codes = (breaches: readonly { code: BreachCode }[]) => breaches.map((b) => b.code);

describe('selectFactsAsOf', () => {
  it('keeps only the latest statement per custodian, so holdings are not double-counted', () => {
    const facts = [
      fact({ id: 'old', custodianId: 'cust-bny', category: 'CASH', usd: 100, asOf: '2026-03-30T20:00:00Z' }),
      fact({ id: 'new', custodianId: 'cust-bny', category: 'CASH', usd: 150, asOf: '2026-03-31T20:00:00Z' }),
    ];
    const selected = selectFactsAsOf(facts, PERIOD_END);
    expect(selected.map((f) => f.id)).toEqual(['new']);
  });

  it('keeps every line item within the same statement', () => {
    const facts = [
      fact({ id: 'a', custodianId: 'cust-bny', category: 'CASH', usd: 100 }),
      fact({ id: 'b', custodianId: 'cust-bny', category: 'TBILL', usd: 200, maturity: '2026-05-01' }),
    ];
    expect(selectFactsAsOf(facts, PERIOD_END)).toHaveLength(2);
  });

  it('excludes superseded facts', () => {
    const facts = [
      fact({ id: 'wrong', custodianId: 'cust-bny', category: 'CASH', usd: 100, supersededBy: 'right' }),
      fact({ id: 'right', custodianId: 'cust-bny', category: 'CASH', usd: 120 }),
    ];
    expect(selectFactsAsOf(facts, PERIOD_END).map((f) => f.id)).toEqual(['right']);
  });

  it('excludes facts effective after the period end', () => {
    const facts = [
      fact({ id: 'in', custodianId: 'cust-bny', category: 'CASH', usd: 100 }),
      fact({ id: 'future', custodianId: 'cust-sscb', category: 'CASH', usd: 100, asOf: '2026-04-05T00:00:00Z' }),
    ];
    expect(selectFactsAsOf(facts, PERIOD_END).map((f) => f.id)).toEqual(['in']);
  });

  it('returns facts in a stable order', () => {
    const facts = [
      fact({ id: 'zz', custodianId: 'cust-bny', category: 'CASH', usd: 1 }),
      fact({ id: 'aa', custodianId: 'cust-bny', category: 'CASH', usd: 1 }),
    ];
    expect(selectFactsAsOf(facts, PERIOD_END).map((f) => f.id)).toEqual(['aa', 'zz']);
  });
});

describe('computePeriod — baseline', () => {
  const result = computePeriod(baselineScenario());

  it('totals reserves exactly', () => {
    // 2,000,000 + 5,000,000 + 3,500,000
    expect(result.totalReserveValueMinor).toBe(1_050_000_000n);
  });

  it('totals outstanding supply across chains', () => {
    // 7,000,000 + 3,000,000 tokens at $1
    expect(result.totalOutstandingMinor).toBe(1_000_000_000n);
  });

  it('computes collateralization at 105%', () => {
    expect(result.collateralizationRatioBps).toBe(10_500);
  });

  it('reports no breaches for a compliant period', () => {
    expect(result.breaches).toEqual([]);
  });

  it('splits composition by category with percentages summing to 100%', () => {
    const cash = result.compositionByCategory.get('CASH')!;
    const tbill = result.compositionByCategory.get('TBILL')!;
    expect(cash.marketValueMinor).toBe(200_000_000n);
    expect(tbill.marketValueMinor).toBe(850_000_000n);
    expect(cash.percentOfTotalBps + tbill.percentOfTotalBps).toBe(10_000);
  });

  it('weights average tenor by market value', () => {
    // 3.0M at 45d, 3.5M at 81d, 2.0M at 45d => (135 + 283.5 + 90) / 8.5 = 59.82
    const tbill = result.compositionByCategory.get('TBILL')!;
    expect(tbill.weightedAverageTenorDays).toBe('59.82');
  });

  it('reports zero tenor for categories without maturities', () => {
    expect(result.compositionByCategory.get('CASH')!.weightedAverageTenorDays).toBe('0.00');
  });

  it('breaks custody down per category, as the statute requires', () => {
    const tbill = result.compositionByCategory.get('TBILL')!;
    // Euroclear (BE) holds 2.0M of the T-bills; BNY and State Street (US) hold 6.5M.
    expect([...tbill.custodyByJurisdiction]).toEqual([
      ['BE', 200_000_000n],
      ['US', 650_000_000n],
    ]);
  });

  it('records lineage for every contributing fact', () => {
    expect(result.contributingFactIds).toEqual(['f-cash', 'f-tbill-1', 'f-tbill-2', 'f-tbill-3']);
  });
});

describe('computePeriod — breach detection', () => {
  it('flags an instrument maturing beyond 93 days', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      facts: [
        ...scenario.facts,
        fact({
          id: 'f-long',
          custodianId: 'cust-bny',
          category: 'TBILL',
          usd: 1_000,
          maturity: '2026-07-15',
          cusip: '912797ZZ9',
        }),
      ],
    });
    expect(codes(result.breaches)).toContain('TENOR_EXCEEDED');
  });

  it('does not flag an instrument at exactly the 93-day boundary', () => {
    const scenario = baselineScenario();
    // 2026-03-31 + 93 days = 2026-07-02
    const result = computePeriod({
      ...scenario,
      facts: [
        ...scenario.facts,
        fact({
          id: 'f-boundary',
          custodianId: 'cust-bny',
          category: 'TBILL',
          usd: 1_000,
          maturity: '2026-07-02',
        }),
      ],
    });
    expect(codes(result.breaches)).not.toContain('TENOR_EXCEEDED');
  });

  it('flags one day past the boundary', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      facts: [
        ...scenario.facts,
        fact({
          id: 'f-over',
          custodianId: 'cust-bny',
          category: 'TBILL',
          usd: 1_000,
          maturity: '2026-07-03',
        }),
      ],
    });
    expect(codes(result.breaches)).toContain('TENOR_EXCEEDED');
  });

  it('flags an ineligible asset category', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      facts: [
        ...scenario.facts,
        fact({ id: 'f-corp', custodianId: 'cust-bny', category: 'OTHER', usd: 500_000 }),
      ],
    });
    const breach = result.breaches.find((b) => b.code === 'INELIGIBLE_ASSET');
    expect(breach?.severity).toBe('CRITICAL');
    expect(breach?.subjects).toEqual(['f-corp']);
  });

  it('flags undercollateralization as critical', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      supplyFacts: [supply('s-eth', 'dep-eth', 11_000_000), supply('s-base', 'dep-base', 1_000_000)],
    });
    expect(result.collateralizationRatioBps).toBeLessThan(10_000);
    const breach = result.breaches.find((b) => b.code === 'UNDERCOLLATERALIZED');
    expect(breach?.severity).toBe('CRITICAL');
  });

  it('warns on a thin buffer without calling it a breach of backing', () => {
    const scenario = baselineScenario();
    // 10.5M reserves against 10.49M outstanding => 100.10%
    const result = computePeriod({
      ...scenario,
      supplyFacts: [supply('s-eth', 'dep-eth', 10_490_000), supply('s-base', 'dep-base', 0)],
    });
    expect(codes(result.breaches)).toContain('THIN_BUFFER');
    expect(codes(result.breaches)).not.toContain('UNDERCOLLATERALIZED');
  });

  it('warns when one custodian holds more than half the reserves', () => {
    const result = computePeriod(baselineScenario());
    // BNY holds 7.0M of 10.5M = 66.7%
    const breach = result.breaches.find((b) => b.code === 'CUSTODIAN_CONCENTRATION');
    expect(breach).toBeUndefined(); // baseline is clean by construction
    const concentrated = computePeriod({
      ...baselineScenario(),
      config: { ...DEFAULT_RULE_CONFIG, custodianConcentrationBps: 5_000 },
      facts: [
        fact({ id: 'f-a', custodianId: 'cust-bny', category: 'CASH', usd: 9_000_000 }),
        fact({ id: 'f-b', custodianId: 'cust-sscb', category: 'CASH', usd: 1_000_000 }),
      ],
    });
    expect(codes(concentrated.breaches)).toContain('CUSTODIAN_CONCENTRATION');
  });

  it('warns when a custodian feed goes stale', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      facts: [
        fact({
          id: 'f-stale',
          custodianId: 'cust-bny',
          category: 'CASH',
          usd: 10_500_000,
          asOf: '2026-03-25T00:00:00Z',
          observedAt: '2026-03-25T00:00:00Z',
        }),
      ],
    });
    expect(codes(result.breaches)).toContain('STALE_DATA');
  });

  it('treats a missing supply observation as critical, not as zero supply', () => {
    const scenario = baselineScenario();
    const result = computePeriod({ ...scenario, supplyFacts: [supply('s-eth', 'dep-eth', 7_000_000)] });
    const breach = result.breaches.find((b) => b.code === 'NO_SUPPLY_OBSERVATION');
    expect(breach?.severity).toBe('CRITICAL');
    expect(breach?.subjects).toEqual(['dep-base']);
  });

  it('excludes unpriceable currency from totals and says so loudly', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      facts: [
        ...scenario.facts,
        fact({ id: 'f-gbp', custodianId: 'cust-euro', category: 'CASH', usd: 1_000_000, currency: 'GBP' }),
      ],
    });
    expect(result.totalReserveValueMinor).toBe(1_050_000_000n);
    const breach = result.breaches.find((b) => b.code === 'MISSING_FX_RATE');
    expect(breach?.severity).toBe('CRITICAL');
    expect(breach?.subjects).toEqual(['GBP']);
  });

  it('orders breaches deterministically with critical first', () => {
    const scenario = baselineScenario();
    const result = computePeriod({
      ...scenario,
      facts: [
        fact({ id: 'f-bad', custodianId: 'cust-bny', category: 'OTHER', usd: 10_500_000 }),
      ],
      supplyFacts: [supply('s-eth', 'dep-eth', 20_000_000), supply('s-base', 'dep-base', 0)],
    });
    const severities = result.breaches.map((b) => b.severity);
    const firstWarning = severities.indexOf('WARNING');
    if (firstWarning !== -1) {
      expect(severities.slice(firstWarning).every((s) => s === 'WARNING')).toBe(true);
    }
  });
});

describe('computePeriod — multi-currency', () => {
  it('converts non-USD holdings at the supplied rate', () => {
    const result = computePeriod({
      asOf: PERIOD_END,
      facts: [
        fact({ id: 'f-usd', custodianId: 'cust-bny', category: 'CASH', usd: 1_000_000 }),
        fact({ id: 'f-eur', custodianId: 'cust-euro', category: 'CASH', usd: 1_000_000, currency: 'EUR' }),
      ],
      supplyFacts: [supply('s-eth', 'dep-eth', 2_000_000)],
      deployments: [DEPLOYMENTS[0]!],
      custodians: CUSTODIANS,
      fx: rates({ EUR: '1.0852' }),
    });
    // 1,000,000 USD + 1,000,000 EUR * 1.0852
    expect(result.totalReserveValueMinor).toBe(100_000_000n + 108_520_000n);
  });

  it('attributes custody to the custodian jurisdiction, not the currency', () => {
    const result = computePeriod({
      asOf: PERIOD_END,
      facts: [
        fact({ id: 'f-eur', custodianId: 'cust-euro', category: 'CASH', usd: 1_000_000, currency: 'EUR' }),
      ],
      supplyFacts: [supply('s-eth', 'dep-eth', 1_000_000)],
      deployments: [DEPLOYMENTS[0]!],
      custodians: CUSTODIANS,
      fx: rates({ EUR: '1.0852' }),
    });
    expect([...result.custodyByJurisdiction.keys()]).toEqual(['BE']);
  });
});

describe('computePeriod — edge cases', () => {
  it('returns a null ratio rather than dividing by zero when nothing is outstanding', () => {
    const result = computePeriod({
      ...baselineScenario(),
      supplyFacts: [supply('s-eth', 'dep-eth', 0), supply('s-base', 'dep-base', 0)],
    });
    expect(result.collateralizationRatioBps).toBeNull();
    expect(codes(result.breaches)).not.toContain('UNDERCOLLATERALIZED');
  });

  it('handles an empty period without throwing', () => {
    const result = computePeriod({
      asOf: PERIOD_END,
      facts: [],
      supplyFacts: [],
      deployments: [],
      custodians: CUSTODIANS,
      fx: rates({}),
    });
    expect(result.totalReserveValueMinor).toBe(0n);
    expect(result.collateralizationRatioBps).toBeNull();
  });

  it('ignores inactive deployments', () => {
    const result = computePeriod({
      ...baselineScenario(),
      deployments: [DEPLOYMENTS[0]!, { ...DEPLOYMENTS[1]!, active: false }],
    });
    expect(result.supplyByChain).toHaveLength(1);
    expect(result.totalOutstandingMinor).toBe(700_000_000n);
  });

  it('computes a period ending on a leap day', () => {
    const leapEnd = new Date('2028-02-29T23:59:59.000Z');
    const result = computePeriod({
      asOf: leapEnd,
      facts: [
        fact({
          id: 'f-leap',
          custodianId: 'cust-bny',
          category: 'TBILL',
          usd: 1_000_000,
          maturity: '2028-05-01',
          asOf: '2028-02-29T20:00:00Z',
        }),
      ],
      supplyFacts: [supply('s-eth', 'dep-eth', 1_000_000, 6, 1n, '2028-02-29T22:00:00Z')],
      deployments: [DEPLOYMENTS[0]!],
      custodians: CUSTODIANS,
      fx: rates({}, leapEnd),
    });
    expect(result.collateralizationRatioBps).toBe(10_000);
    expect(result.compositionByCategory.get('TBILL')!.weightedAverageTenorDays).toBe('62.00');
  });

  it('picks the highest block, not the latest ingestion, for supply', () => {
    const early = supply('s-early', 'dep-eth', 1_000_000, 6, 100n, '2026-03-31T10:00:00Z');
    const late = supply('s-late', 'dep-eth', 2_000_000, 6, 200n, '2026-03-31T22:00:00Z');
    const result = computePeriod({
      asOf: PERIOD_END,
      facts: [fact({ id: 'f', custodianId: 'cust-bny', category: 'CASH', usd: 2_000_000 })],
      // Deliberately out of order.
      supplyFacts: [late, early],
      deployments: [DEPLOYMENTS[0]!],
      custodians: CUSTODIANS,
      fx: rates({}),
    });
    expect(result.supplyByChain[0]!.blockNumber).toBe(200n);
  });

  it('ignores supply observed after the period end', () => {
    const inPeriod = supply('s-in', 'dep-eth', 1_000_000, 6, 100n, '2026-03-31T10:00:00Z');
    const after = supply('s-after', 'dep-eth', 9_000_000, 6, 300n, '2026-04-02T10:00:00Z');
    const result = computePeriod({
      asOf: PERIOD_END,
      facts: [fact({ id: 'f', custodianId: 'cust-bny', category: 'CASH', usd: 2_000_000 })],
      supplyFacts: [inPeriod, after],
      deployments: [DEPLOYMENTS[0]!],
      custodians: CUSTODIANS,
      fx: rates({}),
    });
    expect(result.totalOutstandingMinor).toBe(100_000_000n);
  });
});
