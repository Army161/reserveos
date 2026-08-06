/**
 * Core domain types for ReserveOS.
 *
 * Money is always `bigint` minor units (cents). Token supply is always `bigint`
 * unscaled uint256. Neither is ever represented as a JS `number` — a rounding
 * error here is a wrong figure on a report a CEO signs under criminal liability.
 */

/** Reserve asset categories. Eligibility under GENIUS Act s.4 is defined in `rules.ts`. */
export const INSTRUMENT_CATEGORIES = [
  'CASH',
  'FED_DEPOSIT',
  'TBILL',
  'MMF',
  'REPO',
  'OTHER',
] as const;

export type InstrumentCategory = (typeof INSTRUMENT_CATEGORIES)[number];

/**
 * A single observed reserve holding. Append-only: a correction is a new fact
 * whose predecessor carries `supersededBy`, never an edit.
 */
export interface ReserveFact {
  readonly id: string;
  readonly issuerId: string;
  readonly custodianId: string;
  /** The custodian's stated effective time for this position. */
  readonly asOf: Date;
  /** When ReserveOS ingested it. */
  readonly observedAt: Date;
  readonly instrumentCategory: InstrumentCategory;
  readonly cusip: string | null;
  /** ISO 4217. Converted to USD via `FxRates` during computation. */
  readonly currency: string;
  readonly faceValueMinor: bigint;
  readonly marketValueMinor: bigint;
  /** Null for instruments without a maturity (cash, demand deposits). */
  readonly maturityDate: Date | null;
  readonly sourceHash: string;
  readonly supersededBy: string | null;
}

/** An observation of a token contract's total supply at a specific block. */
export interface SupplyFact {
  readonly id: string;
  readonly tokenDeploymentId: string;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
  /** uint256, unscaled. */
  readonly totalSupply: bigint;
  readonly observedAt: Date;
}

export interface TokenDeployment {
  readonly id: string;
  readonly issuerId: string;
  readonly chainId: number;
  readonly contractAddress: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly active: boolean;
}

export interface Custodian {
  readonly id: string;
  readonly issuerId: string;
  readonly name: string;
  /** ISO 3166-1 alpha-2. Drives the custody-geography disclosure. */
  readonly jurisdiction: string;
}

/**
 * FX rates to USD, scaled by 1e8. A rate of 1.08520000 EUR->USD is 108_520_000n.
 * USD is always present and always exactly `FX_SCALE`.
 */
export interface FxRates {
  readonly asOf: Date;
  readonly source: string;
  readonly ratesToUsd: ReadonlyMap<string, bigint>;
}

export type BreachSeverity = 'CRITICAL' | 'WARNING';

export type BreachCode =
  | 'INELIGIBLE_ASSET'
  | 'TENOR_EXCEEDED'
  | 'UNDERCOLLATERALIZED'
  | 'THIN_BUFFER'
  | 'CUSTODIAN_CONCENTRATION'
  | 'STALE_DATA'
  | 'MISSING_FX_RATE'
  | 'NO_SUPPLY_OBSERVATION';

export interface Breach {
  readonly code: BreachCode;
  readonly severity: BreachSeverity;
  /** Human-readable, shown in the console and included in the report pack. */
  readonly detail: string;
  /** Fact / custodian / deployment ids that triggered this breach. */
  readonly subjects: readonly string[];
}

export interface CategoryBreakdown {
  readonly marketValueMinor: bigint;
  /** Basis points of total reserves. Integer, so it is exactly reproducible. */
  readonly percentOfTotalBps: number;
  /** Value-weighted mean tenor, 2dp decimal string. '0.00' when no maturities. */
  readonly weightedAverageTenorDays: string;
  /**
   * Custody location for this category, keyed by ISO 3166-1 alpha-2.
   *
   * GENIUS Act s.4(a)(1)(C) requires geographic location of custody to be
   * disclosed *per category of reserve instrument*, not merely in aggregate.
   */
  readonly custodyByJurisdiction: ReadonlyMap<string, bigint>;
}

export interface ChainSupply {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly totalSupply: bigint;
  readonly decimals: number;
  readonly outstandingMinor: bigint;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
}

/**
 * The complete computed state of a reporting period. Deterministic: recomputing
 * from the same facts must produce an identical value, byte for byte, forever.
 */
export interface PeriodComputation {
  readonly asOf: Date;
  readonly totalReserveValueMinor: bigint;
  readonly compositionByCategory: ReadonlyMap<InstrumentCategory, CategoryBreakdown>;
  readonly custodyByJurisdiction: ReadonlyMap<string, bigint>;
  readonly reservesByCustodian: ReadonlyMap<string, bigint>;
  readonly supplyByChain: readonly ChainSupply[];
  readonly totalOutstandingMinor: bigint;
  /** Reserves / outstanding, in basis points. Null when nothing is outstanding. */
  readonly collateralizationRatioBps: number | null;
  readonly breaches: readonly Breach[];
  /** Ids of every fact that contributed, for report lineage. */
  readonly contributingFactIds: readonly string[];
}
