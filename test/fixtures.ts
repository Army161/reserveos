import type {
  Custodian,
  FxRates,
  InstrumentCategory,
  ReserveFact,
  SupplyFact,
  TokenDeployment,
} from '../src/domain/types.js';
import { FX_SCALE } from '../src/domain/money.js';

export const ISSUER_ID = 'issuer-0001';

export const CUSTODIANS: Custodian[] = [
  { id: 'cust-bny', issuerId: ISSUER_ID, name: 'BNY Mellon', jurisdiction: 'US' },
  { id: 'cust-sscb', issuerId: ISSUER_ID, name: 'State Street', jurisdiction: 'US' },
  { id: 'cust-euro', issuerId: ISSUER_ID, name: 'Euroclear', jurisdiction: 'BE' },
];

export const DEPLOYMENTS: TokenDeployment[] = [
  {
    id: 'dep-eth',
    issuerId: ISSUER_ID,
    chainId: 1,
    contractAddress: '0xaaaa000000000000000000000000000000000001',
    symbol: 'ACME',
    decimals: 6,
    active: true,
  },
  {
    id: 'dep-base',
    issuerId: ISSUER_ID,
    chainId: 8453,
    contractAddress: '0xbbbb000000000000000000000000000000000002',
    symbol: 'ACME',
    decimals: 6,
    active: true,
  },
];

interface FactSpec {
  id: string;
  custodianId: string;
  category: InstrumentCategory;
  /** Whole dollars, for readability in fixtures. */
  usd: number;
  currency?: string;
  maturity?: string | null;
  asOf?: string;
  observedAt?: string;
  cusip?: string | null;
  supersededBy?: string | null;
}

const DEFAULT_AS_OF = '2026-03-31T20:00:00.000Z';

export function fact(spec: FactSpec): ReserveFact {
  const asOf = new Date(spec.asOf ?? DEFAULT_AS_OF);
  const minor = BigInt(Math.round(spec.usd * 100));
  return {
    id: spec.id,
    issuerId: ISSUER_ID,
    custodianId: spec.custodianId,
    asOf,
    observedAt: new Date(spec.observedAt ?? spec.asOf ?? DEFAULT_AS_OF),
    instrumentCategory: spec.category,
    cusip: spec.cusip ?? null,
    currency: spec.currency ?? 'USD',
    faceValueMinor: minor,
    marketValueMinor: minor,
    maturityDate: spec.maturity == null ? null : new Date(spec.maturity),
    sourceHash: 'f'.repeat(64),
    supersededBy: spec.supersededBy ?? null,
  };
}

export function supply(
  id: string,
  deploymentId: string,
  tokens: number,
  decimals = 6,
  blockNumber = 1_000_000n,
  blockTimestamp = '2026-03-31T23:50:00.000Z',
): SupplyFact {
  return {
    id,
    tokenDeploymentId: deploymentId,
    blockNumber,
    blockTimestamp: new Date(blockTimestamp),
    totalSupply: BigInt(Math.round(tokens * 10 ** decimals)),
    observedAt: new Date(blockTimestamp),
  };
}

export function rates(entries: Record<string, string>, asOf = new Date(DEFAULT_AS_OF)): FxRates {
  const map = new Map<string, bigint>([['USD', FX_SCALE]]);
  for (const [currency, rate] of Object.entries(entries)) {
    // '1.0852' -> 108_520_000n
    const [whole, frac = ''] = rate.split('.');
    const padded = (frac + '00000000').slice(0, 8);
    map.set(currency, BigInt(whole!) * FX_SCALE + BigInt(padded));
  }
  return { asOf, source: 'test-fixture', ratesToUsd: map };
}

/**
 * Period end is the last instant of the month. Custodian statements are stamped
 * earlier in the day and chain observations land later, so both fall inside it —
 * which is exactly the ordering a real month-end has.
 */
export const PERIOD_END = new Date('2026-03-31T23:59:59.999Z');
export const PERIOD_START = new Date('2026-03-01T00:00:00.000Z');

/**
 * A clean, fully-compliant baseline: $10.5M reserves against $10M outstanding,
 * spread across three custodians so no concentration warning fires.
 */
export function baselineScenario() {
  return {
    asOf: PERIOD_END,
    facts: [
      fact({ id: 'f-cash', custodianId: 'cust-bny', category: 'CASH', usd: 2_000_000 }),
      fact({
        id: 'f-tbill-1',
        custodianId: 'cust-bny',
        category: 'TBILL',
        usd: 3_000_000,
        maturity: '2026-05-15',
        cusip: '912797KL5',
      }),
      fact({
        id: 'f-tbill-2',
        custodianId: 'cust-sscb',
        category: 'TBILL',
        usd: 3_500_000,
        maturity: '2026-06-20',
        cusip: '912797MM3',
      }),
      fact({
        id: 'f-tbill-3',
        custodianId: 'cust-euro',
        category: 'TBILL',
        usd: 2_000_000,
        maturity: '2026-05-15',
        cusip: '912797KL5',
      }),
    ],
    supplyFacts: [supply('s-eth', 'dep-eth', 7_000_000), supply('s-base', 'dep-base', 3_000_000)],
    deployments: DEPLOYMENTS,
    custodians: CUSTODIANS,
    fx: rates({}),
  };
}
