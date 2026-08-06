import {
  INSTRUMENT_CATEGORIES,
  type Breach,
  type Custodian,
  type InstrumentCategory,
  type ReserveFact,
  type TokenDeployment,
} from './types.js';
import { formatMinor, formatRatio, tenorDays, toBps, BPS_SCALE } from './money.js';

/**
 * Compliance rule thresholds.
 *
 * Defaults encode GENIUS Act s.4 reserve requirements and the OCC proposed
 * supervisory framework. They are configurable per issuer because state
 * regimes and MiCA differ, and because a conservative issuer may want to be
 * alerted well before the statutory line.
 */
export interface RuleConfig {
  /** Statutory maximum residual maturity for Treasury holdings, in days. */
  readonly maxTenorDays: number;
  readonly eligibleCategories: ReadonlySet<InstrumentCategory>;
  /** Warn below this collateralization level, in bps. 10_025 = 100.25%. */
  readonly thinBufferBps: number;
  /** Warn above this share held at a single custodian, in bps. */
  readonly custodianConcentrationBps: number;
  /** Warn when a custodian has produced no data for this many hours. */
  readonly staleDataHours: number;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  maxTenorDays: 93,
  eligibleCategories: new Set<InstrumentCategory>(['CASH', 'FED_DEPOSIT', 'TBILL', 'MMF', 'REPO']),
  thinBufferBps: 10_025,
  custodianConcentrationBps: 5_000,
  staleDataHours: 48,
};

/** Deterministic ordering: CRITICAL before WARNING, then by code, then by subject. */
const SEVERITY_RANK = { CRITICAL: 0, WARNING: 1 } as const;

function compareBreaches(a: Breach, b: Breach): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const aKey = a.subjects.join(',');
  const bKey = b.subjects.join(',');
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}

export interface RuleInput {
  readonly asOf: Date;
  readonly facts: readonly ReserveFact[];
  readonly custodians: ReadonlyMap<string, Custodian>;
  readonly totalReserveValueMinor: bigint;
  readonly reservesByCustodian: ReadonlyMap<string, bigint>;
  readonly totalOutstandingMinor: bigint;
  readonly collateralizationRatioBps: number | null;
  readonly deploymentsWithoutSupply: readonly TokenDeployment[];
  readonly missingFxCurrencies: readonly string[];
  readonly config: RuleConfig;
}

/**
 * Evaluate every compliance rule against a computed period.
 *
 * Returns a deterministically ordered list so that two runs over identical
 * facts produce byte-identical report payloads.
 */
export function evaluateBreaches(input: RuleInput): Breach[] {
  const breaches: Breach[] = [];
  const { config, asOf } = input;

  // --- Reserve asset eligibility (GENIUS Act s.4(a)(1)(A)) --------------
  for (const fact of input.facts) {
    if (!config.eligibleCategories.has(fact.instrumentCategory)) {
      breaches.push({
        code: 'INELIGIBLE_ASSET',
        severity: 'CRITICAL',
        detail:
          `${formatMinor(fact.marketValueMinor)} ${fact.currency} held as ` +
          `${fact.instrumentCategory}, which is not a permitted reserve asset`,
        subjects: [fact.id],
      });
    }
  }

  // --- Residual maturity limit -----------------------------------------
  for (const fact of input.facts) {
    if (fact.maturityDate === null) continue;
    const days = tenorDays(asOf, fact.maturityDate);
    if (days > config.maxTenorDays) {
      breaches.push({
        code: 'TENOR_EXCEEDED',
        severity: 'CRITICAL',
        detail:
          `${fact.cusip ?? fact.instrumentCategory} matures in ${days} days, ` +
          `exceeding the ${config.maxTenorDays}-day limit`,
        subjects: [fact.id],
      });
    }
  }

  // --- Collateralization -----------------------------------------------
  const ratioBps = input.collateralizationRatioBps;
  if (ratioBps !== null) {
    if (ratioBps < Number(BPS_SCALE)) {
      breaches.push({
        code: 'UNDERCOLLATERALIZED',
        severity: 'CRITICAL',
        detail:
          `Reserves cover ${formatRatio(BigInt(ratioBps), 100n, 2)}% of outstanding ` +
          `stablecoins; 1:1 backing is required`,
        subjects: [],
      });
    } else if (ratioBps < config.thinBufferBps) {
      breaches.push({
        code: 'THIN_BUFFER',
        severity: 'WARNING',
        detail:
          `Collateralization is ${formatRatio(BigInt(ratioBps), 100n, 2)}%, below the ` +
          `${formatRatio(BigInt(config.thinBufferBps), 100n, 2)}% internal buffer`,
        subjects: [],
      });
    }
  }

  // --- Custodian concentration -----------------------------------------
  const custodianIds = [...input.reservesByCustodian.keys()].sort();
  for (const custodianId of custodianIds) {
    const value = input.reservesByCustodian.get(custodianId)!;
    const shareBps = toBps(value, input.totalReserveValueMinor);
    if (shareBps > config.custodianConcentrationBps) {
      const name = input.custodians.get(custodianId)?.name ?? custodianId;
      breaches.push({
        code: 'CUSTODIAN_CONCENTRATION',
        severity: 'WARNING',
        detail:
          `${name} holds ${formatRatio(BigInt(shareBps), 100n, 2)}% of reserves, above ` +
          `the ${formatRatio(BigInt(config.custodianConcentrationBps), 100n, 2)}% threshold`,
        subjects: [custodianId],
      });
    }
  }

  // --- Data freshness ---------------------------------------------------
  const latestByCustodian = new Map<string, Date>();
  for (const fact of input.facts) {
    const current = latestByCustodian.get(fact.custodianId);
    if (current === undefined || fact.observedAt > current) {
      latestByCustodian.set(fact.custodianId, fact.observedAt);
    }
  }
  const staleCutoffMs = config.staleDataHours * 3_600_000;
  for (const custodianId of [...latestByCustodian.keys()].sort()) {
    const latest = latestByCustodian.get(custodianId)!;
    const ageMs = asOf.getTime() - latest.getTime();
    if (ageMs > staleCutoffMs) {
      const name = input.custodians.get(custodianId)?.name ?? custodianId;
      const ageHours = Math.floor(ageMs / 3_600_000);
      breaches.push({
        code: 'STALE_DATA',
        severity: 'WARNING',
        detail: `No data from ${name} for ${ageHours} hours`,
        subjects: [custodianId],
      });
    }
  }

  // --- Data completeness -------------------------------------------------
  // A missing supply observation understates outstanding tokens, which inflates
  // the collateralization ratio. Critical: it makes the headline figure wrong.
  for (const deployment of input.deploymentsWithoutSupply) {
    breaches.push({
      code: 'NO_SUPPLY_OBSERVATION',
      severity: 'CRITICAL',
      detail:
        `No supply observation at or before period end for ${deployment.symbol} on ` +
        `chain ${deployment.chainId} (${deployment.contractAddress})`,
      subjects: [deployment.id],
    });
  }

  for (const currency of [...input.missingFxCurrencies].sort()) {
    breaches.push({
      code: 'MISSING_FX_RATE',
      severity: 'CRITICAL',
      detail: `No USD rate available for ${currency}; holdings excluded from totals`,
      subjects: [currency],
    });
  }

  return breaches.sort(compareBreaches);
}

/** Category display order for report output. */
export const CATEGORY_ORDER: readonly InstrumentCategory[] = INSTRUMENT_CATEGORIES;
