import type { CanonicalValue } from './canonical.js';
import { canonicalHash, canonicalize } from './canonical.js';
import { formatMinor, formatRatio } from './money.js';
import type { Breach, PeriodComputation } from './types.js';

/**
 * Assembly of the statutory monthly reserve report.
 *
 * Every quantity is emitted as a decimal *string*. See `canonical.ts` for why
 * JSON numbers are banned from hashed payloads.
 */

/** Schema version. Bumping this changes every hash, so it is part of the record. */
export const REPORT_SCHEMA_VERSION = 'reserveos.report/v1';

export interface ReportIssuer {
  readonly id: string;
  readonly legalName: string;
  readonly regulator: string;
}

export interface RedemptionSummary {
  readonly requestCount: number;
  readonly settledCount: number;
  readonly breachedCount: number;
  /** Median settlement time in whole minutes. Null when nothing settled. */
  readonly medianSettlementMinutes: number | null;
}

export interface BuildReportInput {
  readonly issuer: ReportIssuer;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly computation: PeriodComputation;
  readonly redemptions: RedemptionSummary;
  readonly fxSource: string;
  /** Set explicitly by the caller; never read from the system clock here. */
  readonly generatedAt: Date;
}

export interface AssembledReport {
  readonly payload: CanonicalValue;
  readonly payloadHash: string;
  readonly canonicalJson: string;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function breachToPayload(breach: Breach): CanonicalValue {
  return {
    code: breach.code,
    severity: breach.severity,
    detail: breach.detail,
    subjects: [...breach.subjects],
  };
}

/**
 * Build the canonical report payload.
 *
 * Deterministic by construction: no clock reads, no iteration over unordered
 * collections, no floats. `generatedAt` is injected so that regenerating a
 * historical report reproduces its original hash exactly.
 */
export function buildReport(input: BuildReportInput): AssembledReport {
  const { computation: c } = input;

  const composition: CanonicalValue[] = [];
  for (const [category, breakdown] of c.compositionByCategory) {
    composition.push({
      category,
      marketValueUsd: formatMinor(breakdown.marketValueMinor),
      percentOfTotal: formatRatio(BigInt(breakdown.percentOfTotalBps), 100n, 2),
      weightedAverageTenorDays: breakdown.weightedAverageTenorDays,
      custodyByJurisdiction: [...breakdown.custodyByJurisdiction].map(
        ([jurisdiction, amount]) => ({
          jurisdiction,
          marketValueUsd: formatMinor(amount),
        }),
      ),
    });
  }

  const outstandingByChain: CanonicalValue[] = c.supplyByChain.map((s) => ({
    chainId: String(s.chainId),
    contractAddress: s.contractAddress,
    totalSupplyRaw: s.totalSupply.toString(),
    decimals: String(s.decimals),
    outstandingUsd: formatMinor(s.outstandingMinor),
    observedAtBlock: s.blockNumber.toString(),
    observedAtBlockTime: s.blockTimestamp.toISOString(),
  }));

  const payload: CanonicalValue = {
    schema: REPORT_SCHEMA_VERSION,
    issuer: {
      id: input.issuer.id,
      legalName: input.issuer.legalName,
      regulator: input.issuer.regulator,
    },
    period: {
      start: isoDate(input.periodStart),
      end: isoDate(input.periodEnd),
      asOf: input.computation.asOf.toISOString(),
    },
    generatedAt: input.generatedAt.toISOString(),
    reserves: {
      totalMarketValueUsd: formatMinor(c.totalReserveValueMinor),
      fxSource: input.fxSource,
      composition,
      custodyByJurisdiction: [...c.custodyByJurisdiction].map(([jurisdiction, amount]) => ({
        jurisdiction,
        marketValueUsd: formatMinor(amount),
      })),
    },
    outstanding: {
      totalUsd: formatMinor(c.totalOutstandingMinor),
      byChain: outstandingByChain,
    },
    collateralization: {
      ratio:
        c.collateralizationRatioBps === null
          ? null
          : formatRatio(BigInt(c.collateralizationRatioBps), 10_000n, 4),
      ratioPercent:
        c.collateralizationRatioBps === null
          ? null
          : formatRatio(BigInt(c.collateralizationRatioBps), 100n, 2),
    },
    redemptions: {
      requestCount: String(input.redemptions.requestCount),
      settledCount: String(input.redemptions.settledCount),
      breachedCount: String(input.redemptions.breachedCount),
      medianSettlementMinutes:
        input.redemptions.medianSettlementMinutes === null
          ? null
          : String(input.redemptions.medianSettlementMinutes),
    },
    breaches: c.breaches.map(breachToPayload),
    lineage: {
      contributingFactIds: [...c.contributingFactIds],
    },
  };

  const canonicalJson = canonicalize(payload);
  return { payload, payloadHash: canonicalHash(payload), canonicalJson };
}

/**
 * The public-disclosure variant published on the issuer's website.
 *
 * Drops internal lineage, per-custodian detail and warning-level breaches. It is
 * hashed and anchored separately so the public artifact is independently
 * verifiable too.
 */
export function buildPublicDisclosure(report: AssembledReport): AssembledReport {
  const full = report.payload as Record<string, CanonicalValue>;
  const reserves = full['reserves'] as Record<string, CanonicalValue>;

  const payload: CanonicalValue = {
    schema: 'reserveos.public-disclosure/v1',
    issuer: full['issuer']!,
    period: full['period']!,
    generatedAt: full['generatedAt']!,
    reserves: {
      totalMarketValueUsd: reserves['totalMarketValueUsd']!,
      composition: reserves['composition']!,
      custodyByJurisdiction: reserves['custodyByJurisdiction']!,
    },
    outstanding: full['outstanding']!,
    collateralization: full['collateralization']!,
    certifiedReportHash: report.payloadHash,
  };

  return {
    payload,
    payloadHash: canonicalHash(payload),
    canonicalJson: canonicalize(payload),
  };
}

/** Report is blocked from certification while any CRITICAL breach is open. */
export function hasCriticalBreach(computation: PeriodComputation): boolean {
  return computation.breaches.some((b) => b.severity === 'CRITICAL');
}
