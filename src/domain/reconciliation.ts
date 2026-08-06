import {
  type CategoryBreakdown,
  type ChainSupply,
  type Custodian,
  type FxRates,
  type InstrumentCategory,
  type PeriodComputation,
  type ReserveFact,
  type SupplyFact,
  type TokenDeployment,
} from './types.js';
import {
  convertToUsdMinor,
  divRound,
  formatRatio,
  supplyToMinor,
  tenorDays,
  toBps,
  BPS_SCALE,
  FX_SCALE,
} from './money.js';
import { CATEGORY_ORDER, DEFAULT_RULE_CONFIG, evaluateBreaches, type RuleConfig } from './rules.js';

export interface ComputePeriodInput {
  /** Period end. All selection is "at or before" this instant. */
  readonly asOf: Date;
  /** The full fact set. Selection and supersession are handled here. */
  readonly facts: readonly ReserveFact[];
  readonly supplyFacts: readonly SupplyFact[];
  readonly deployments: readonly TokenDeployment[];
  readonly custodians: readonly Custodian[];
  readonly fx: FxRates;
  readonly config?: RuleConfig;
}

/**
 * Select the reserve facts that represent the issuer's position at `asOf`.
 *
 * Custodians publish a complete position statement per effective date, so the
 * live position is *the latest statement*, not the union of all statements.
 * Summing across statement dates would double-count every holding — this
 * selection step is the difference between a correct total and a catastrophic
 * overstatement of reserves.
 */
export function selectFactsAsOf(
  facts: readonly ReserveFact[],
  asOf: Date,
): readonly ReserveFact[] {
  const eligible = facts.filter(
    (fact) => fact.supersededBy === null && fact.asOf.getTime() <= asOf.getTime(),
  );

  // Latest statement date per custodian.
  const latestStatement = new Map<string, number>();
  for (const fact of eligible) {
    const current = latestStatement.get(fact.custodianId);
    const time = fact.asOf.getTime();
    if (current === undefined || time > current) {
      latestStatement.set(fact.custodianId, time);
    }
  }

  return eligible
    .filter((fact) => latestStatement.get(fact.custodianId) === fact.asOf.getTime())
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Latest supply observation at or before `asOf` for each active deployment. */
export function selectSupplyAsOf(
  supplyFacts: readonly SupplyFact[],
  deployments: readonly TokenDeployment[],
  asOf: Date,
): { selected: Map<string, SupplyFact>; missing: TokenDeployment[] } {
  const selected = new Map<string, SupplyFact>();
  const missing: TokenDeployment[] = [];

  for (const deployment of deployments) {
    if (!deployment.active) continue;

    let best: SupplyFact | undefined;
    for (const fact of supplyFacts) {
      if (fact.tokenDeploymentId !== deployment.id) continue;
      if (fact.blockTimestamp.getTime() > asOf.getTime()) continue;
      if (best === undefined || fact.blockNumber > best.blockNumber) {
        best = fact;
      }
    }

    if (best === undefined) missing.push(deployment);
    else selected.set(deployment.id, best);
  }

  return { selected, missing };
}

/**
 * Compute the complete state of a reporting period from raw facts.
 *
 * Pure and deterministic: identical inputs always produce an identical result,
 * including map iteration order, so the canonical hash of a derived report is
 * stable across processes and across time. `test/determinism.test.ts` enforces
 * this and is the regression net for the entire product.
 */
export function computePeriod(input: ComputePeriodInput): PeriodComputation {
  const config = input.config ?? DEFAULT_RULE_CONFIG;
  const { asOf, fx } = input;

  const facts = selectFactsAsOf(input.facts, asOf);
  const { selected: supplyByDeployment, missing: deploymentsWithoutSupply } = selectSupplyAsOf(
    input.supplyFacts,
    input.deployments,
    asOf,
  );

  const custodianById = new Map(input.custodians.map((c) => [c.id, c] as const));

  // --- Reserve side ------------------------------------------------------
  const missingFxCurrencies = new Set<string>();
  const usdValueByFact = new Map<string, bigint>();

  for (const fact of facts) {
    const rate = fx.ratesToUsd.get(fact.currency);
    if (rate === undefined) {
      missingFxCurrencies.add(fact.currency);
      continue;
    }
    usdValueByFact.set(fact.id, convertToUsdMinor(fact.marketValueMinor, rate));
  }

  // Facts whose currency has no rate are excluded from totals and raise a
  // CRITICAL breach — silently treating them as zero would understate reserves.
  const valuedFacts = facts.filter((fact) => usdValueByFact.has(fact.id));

  let totalReserveValueMinor = 0n;
  for (const fact of valuedFacts) {
    totalReserveValueMinor += usdValueByFact.get(fact.id)!;
  }

  // Category composition, in fixed display order.
  const valueByCategory = new Map<InstrumentCategory, bigint>();
  const tenorWeightByCategory = new Map<InstrumentCategory, bigint>();
  const custodyByCategory = new Map<InstrumentCategory, Map<string, bigint>>();

  for (const fact of valuedFacts) {
    const usd = usdValueByFact.get(fact.id)!;
    valueByCategory.set(
      fact.instrumentCategory,
      (valueByCategory.get(fact.instrumentCategory) ?? 0n) + usd,
    );

    if (fact.maturityDate !== null) {
      const days = BigInt(tenorDays(asOf, fact.maturityDate));
      tenorWeightByCategory.set(
        fact.instrumentCategory,
        (tenorWeightByCategory.get(fact.instrumentCategory) ?? 0n) + usd * days,
      );
    }

    const jurisdiction = custodianById.get(fact.custodianId)?.jurisdiction ?? 'ZZ';
    let perCategory = custodyByCategory.get(fact.instrumentCategory);
    if (perCategory === undefined) {
      perCategory = new Map<string, bigint>();
      custodyByCategory.set(fact.instrumentCategory, perCategory);
    }
    perCategory.set(jurisdiction, (perCategory.get(jurisdiction) ?? 0n) + usd);
  }

  const compositionByCategory = new Map<InstrumentCategory, CategoryBreakdown>();
  for (const category of CATEGORY_ORDER) {
    const value = valueByCategory.get(category);
    if (value === undefined) continue;

    const weightedTenor = tenorWeightByCategory.get(category) ?? 0n;
    const perCategoryCustody = custodyByCategory.get(category) ?? new Map<string, bigint>();

    compositionByCategory.set(category, {
      marketValueMinor: value,
      percentOfTotalBps: toBps(value, totalReserveValueMinor),
      weightedAverageTenorDays: formatRatio(weightedTenor, value, 2),
      custodyByJurisdiction: new Map(
        [...perCategoryCustody.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    });
  }

  // Custody geography and per-custodian concentration.
  const custodyRaw = new Map<string, bigint>();
  const custodianRaw = new Map<string, bigint>();
  for (const fact of valuedFacts) {
    const usd = usdValueByFact.get(fact.id)!;
    const jurisdiction = custodianById.get(fact.custodianId)?.jurisdiction ?? 'ZZ';
    custodyRaw.set(jurisdiction, (custodyRaw.get(jurisdiction) ?? 0n) + usd);
    custodianRaw.set(fact.custodianId, (custodianRaw.get(fact.custodianId) ?? 0n) + usd);
  }

  const custodyByJurisdiction = new Map(
    [...custodyRaw.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const reservesByCustodian = new Map(
    [...custodianRaw.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  // --- Liability side ----------------------------------------------------
  const supplyByChain: ChainSupply[] = [];
  let totalOutstandingMinor = 0n;

  const activeDeployments = input.deployments
    .filter((d) => d.active)
    .slice()
    .sort((a, b) =>
      a.chainId !== b.chainId
        ? a.chainId - b.chainId
        : a.contractAddress < b.contractAddress
          ? -1
          : 1,
    );

  for (const deployment of activeDeployments) {
    const supply = supplyByDeployment.get(deployment.id);
    if (supply === undefined) continue;

    const outstandingMinor = supplyToMinor(supply.totalSupply, deployment.decimals);
    totalOutstandingMinor += outstandingMinor;

    supplyByChain.push({
      chainId: deployment.chainId,
      contractAddress: deployment.contractAddress,
      totalSupply: supply.totalSupply,
      decimals: deployment.decimals,
      outstandingMinor,
      blockNumber: supply.blockNumber,
      blockTimestamp: supply.blockTimestamp,
    });
  }

  const collateralizationRatioBps =
    totalOutstandingMinor === 0n
      ? null
      : Number(divRound(totalReserveValueMinor * BPS_SCALE, totalOutstandingMinor));

  // --- Rules -------------------------------------------------------------
  const breaches = evaluateBreaches({
    asOf,
    facts,
    custodians: custodianById,
    totalReserveValueMinor,
    reservesByCustodian,
    totalOutstandingMinor,
    collateralizationRatioBps,
    deploymentsWithoutSupply,
    missingFxCurrencies: [...missingFxCurrencies],
    config,
  });

  return {
    asOf,
    totalReserveValueMinor,
    compositionByCategory,
    custodyByJurisdiction,
    reservesByCustodian,
    supplyByChain,
    totalOutstandingMinor,
    collateralizationRatioBps,
    breaches,
    contributingFactIds: facts.map((f) => f.id),
  };
}

/** Convenience for tests and fixtures: a USD-only rate table. */
export function usdOnlyRates(asOf: Date): FxRates {
  return {
    asOf,
    source: 'identity',
    ratesToUsd: new Map([['USD', FX_SCALE]]),
  };
}
