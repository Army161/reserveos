import { computePeriod } from '../domain/reconciliation.js';
import { buildReport, buildPublicDisclosure, hasCriticalBreach } from '../domain/report.js';
import type { AssembledReport } from '../domain/report.js';
import type { PeriodComputation } from '../domain/types.js';
import { PgFxRateStore, PgReserveFactStore, PgSupplyFactStore } from '../db/stores/facts.js';
import { PgCustodianStore, PgIssuerStore, PgTokenDeploymentStore } from '../db/stores/reference.js';
import { PgReportStore, type ReportVersion, type ReportingPeriod } from '../db/stores/reports.js';
import { PgRedemptionStore } from '../db/stores/workflow.js';
import { summarize } from './redemption.js';
import type { Queryable } from '../db/pool.js';
import { notFound, unprocessable } from '../api/errors.js';

/**
 * Period assembly: turning stored facts into a computation and a report version.
 *
 * The routes stay thin because everything interesting happens here, and this is
 * exercised directly by tests rather than only through HTTP.
 */

export const DEFAULT_FX_SOURCE = 'ECB';

/** Rebuild the reconciliation engine's inputs entirely from the database. */
export async function loadComputation(
  db: Queryable,
  issuerId: string,
  asOf: Date,
  fxSource: string,
): Promise<PeriodComputation> {
  // Sequential, not Promise.all. `db` is normally a single PoolClient — every
  // authenticated request runs inside `withTenant` — and one client executes one
  // query at a time. Issuing them concurrently silently queues them today and is
  // a hard error in pg@9.
  const facts = await new PgReserveFactStore(db).listCurrentAsOf(issuerId, asOf);
  const supplyFacts = await new PgSupplyFactStore(db).listForIssuerAsOf(issuerId, asOf);
  const deployments = await new PgTokenDeploymentStore(db).listActiveForIssuer(issuerId);
  const custodians = await new PgCustodianStore(db).listForIssuer(issuerId);
  const fx = await new PgFxRateStore(db).ratesAsOf(asOf, fxSource);

  return computePeriod({ asOf, facts, supplyFacts, deployments, custodians, fx });
}

export interface GeneratedReport {
  readonly version: ReportVersion;
  readonly report: AssembledReport;
  readonly computation: PeriodComputation;
}

export interface AssembledForPeriod {
  readonly report: AssembledReport;
  readonly computation: PeriodComputation;
}

/**
 * Assemble a period's report from the facts currently stored, without persisting.
 *
 * Split out from `generateReportVersion` so the same assembly can be replayed
 * against an existing version to ask whether it still reproduces. Everything it
 * reads is a function of (issuer, period, facts as-of, fx, redemptions) plus the
 * caller's `generatedAt`, so replaying it with a stored version's `generatedAt`
 * yields that version's payload byte for byte — unless a fact behind it moved.
 */
export async function assembleReport(
  db: Queryable,
  params: {
    issuerId: string;
    period: ReportingPeriod;
    generatedAt: Date;
    fxSource?: string;
  },
): Promise<AssembledForPeriod> {
  const fxSource = params.fxSource ?? DEFAULT_FX_SOURCE;
  const issuer = await new PgIssuerStore(db).get(params.issuerId);
  if (issuer === null) throw notFound(`issuer ${params.issuerId} not found`);

  // The period ends at the last instant of its end date; the stored column is a
  // DATE, so reconstruct the boundary rather than using midnight, which would
  // exclude the whole final day.
  const asOf = endOfDay(params.period.periodEnd);

  const computation = await loadComputation(db, params.issuerId, asOf, fxSource);

  const redemptions = summarize(
    await new PgRedemptionStore(db).listForPeriod(
      params.issuerId,
      startOfDay(params.period.periodStart),
      asOf,
    ),
  );

  const report = buildReport({
    issuer: {
      id: issuer.id,
      legalName: issuer.legalName,
      regulator: issuer.regulator,
    },
    periodStart: params.period.periodStart,
    periodEnd: params.period.periodEnd,
    computation,
    redemptions,
    fxSource,
    generatedAt: params.generatedAt,
  });

  return { report, computation };
}

/** Raised when a stored version no longer reproduces from the facts on hand. */
export class StaleVersionError extends Error {
  constructor(
    readonly version: number,
    readonly storedHash: string,
    readonly reproducedHash: string,
  ) {
    super(
      `the facts behind report version ${version} have changed since it was generated ` +
        `(stored ${storedHash.slice(0, 12)}…, recomputed ${reproducedHash.slice(0, 12)}…); ` +
        `regenerate the report and certify the new version`,
    );
    this.name = 'StaleVersionError';
  }
}

/**
 * Rebuild a stored version from current facts and confirm it still reproduces.
 *
 * A statutory signature binds `version.payload` — the snapshot taken when the
 * report was generated — but facts keep arriving: a corrected custodian
 * statement, a late supply observation, a superseding correction. Any of those
 * leaves the stored payload describing a world that no longer exists, and
 * nothing else in the system notices, because the "certify only the latest
 * version" guard asks whether a NEWER version exists, not whether this one is
 * still true.
 *
 * Comparing the reproduced hash is the whole check. It is exact and it is total:
 * every figure, every breach, the redemption summary and the fact lineage all
 * feed the hash, so this cannot pass while any input behind the signature has
 * moved. Replaying with the version's own `generatedAt` is what makes the
 * comparison meaningful — that field is in the payload, so using the current
 * clock would make every version look stale.
 */
export async function reproduceVersion(
  db: Queryable,
  params: {
    issuerId: string;
    period: ReportingPeriod;
    version: ReportVersion;
    fxSource?: string;
  },
): Promise<AssembledForPeriod> {
  const assembled = await assembleReport(db, {
    issuerId: params.issuerId,
    period: params.period,
    generatedAt: params.version.generatedAt,
    ...(params.fxSource === undefined ? {} : { fxSource: params.fxSource }),
  });

  if (assembled.report.payloadHash !== params.version.payloadHash) {
    throw new StaleVersionError(
      params.version.version,
      params.version.payloadHash,
      assembled.report.payloadHash,
    );
  }

  return assembled;
}

/**
 * Compute a period and persist a new report version.
 *
 * `generatedAt` is passed in rather than read from the clock so a regenerated
 * historical report reproduces its original hash — the determinism guarantee
 * extends through this layer, not just the pure one.
 */
export async function generateReportVersion(
  db: Queryable,
  params: {
    issuerId: string;
    period: ReportingPeriod;
    generatedBy: string;
    generatedAt: Date;
    fxSource?: string;
  },
): Promise<GeneratedReport> {
  const { report, computation } = await assembleReport(db, {
    issuerId: params.issuerId,
    period: params.period,
    generatedAt: params.generatedAt,
    ...(params.fxSource === undefined ? {} : { fxSource: params.fxSource }),
  });

  const store = new PgReportStore(db);

  let version: ReportVersion;
  try {
    version = await store.insertVersion({
      periodId: params.period.id,
      payload: report.payload,
      payloadHash: report.payloadHash,
      generatedAt: params.generatedAt,
      generatedBy: params.generatedBy,
    });
  } catch (error) {
    // An identical payload hash means nothing that feeds the report has changed
    // since the last generation. Creating a second version would attach a new
    // version number to byte-identical figures and invalidate an approval chain
    // already in progress, so return the existing version instead. This also
    // makes generation safe to retry after an ambiguous timeout.
    if (!isPayloadHashCollision(error)) throw error;

    const existing = await store.findByHash(report.payloadHash);
    // `payload_hash` is UNIQUE across the whole table rather than per period, so
    // the row recovered here is not necessarily one of ours. `findByHash` is
    // unscoped and RLS does not scope it either — a PUBLISHED report version is
    // visible to every tenant (see the note on `currentIssuerId`). Adopting that
    // row would return another period's — potentially another issuer's — version
    // id and generation timestamp as the answer to "generate mine". Re-raising
    // the constraint violation is the honest outcome: nothing of ours exists.
    if (existing === null || existing.periodId !== params.period.id) throw error;
    version = existing;
  }

  return { version, report, computation };
}

const PAYLOAD_HASH_CONSTRAINT = 'report_versions_payload_hash_key';

function isPayloadHashCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === PAYLOAD_HASH_CONSTRAINT;
}

/**
 * Publish a certified period.
 *
 * Refuses anything not fully certified. Publication is what makes the figures
 * visible to the unauthenticated verification endpoint, so the gate belongs
 * here as well as in the policy that governs that endpoint.
 */
export async function publishPeriod(
  db: Queryable,
  period: ReportingPeriod,
): Promise<void> {
  if (period.status !== 'CERTIFIED') {
    throw unprocessable(
      `period ${period.id} is ${period.status}; only a CERTIFIED period can be published`,
    );
  }
  await new PgReportStore(db).setPeriodStatus(period.id, 'PUBLISHED');
}

/** The disclosure an examiner sees, derived from a stored report version. */
export function disclosureFor(version: ReportVersion): AssembledReport {
  return buildPublicDisclosure({
    payload: version.payload as never,
    payloadHash: version.payloadHash,
    canonicalJson: '',
  });
}

export { hasCriticalBreach };

export function endOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999),
  );
}

export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The issuer scoping the current transaction, as the database itself reports it.
 *
 * Row-level security is not sufficient on its own for a lookup by primary key.
 * `reserveos_app` is granted membership of `reserveos_public` so the verify
 * endpoint can downgrade itself (migration 006), and Postgres applies a policy
 * to every role the caller is a *member* of — so the permissive
 * `reporting_periods_published` / `report_versions_published` policies OR with
 * the tenant policies for ordinary authenticated traffic. The practical effect
 * is that every RLS check on a published row degrades to "…or it is published,
 * by anyone". Ownership therefore has to be asserted here as well.
 */
async function currentIssuerId(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ issuer_id: string | null }>(
    'SELECT app_current_issuer() AS issuer_id',
  );
  const issuerId = rows[0]?.issuer_id ?? null;
  if (issuerId === null) {
    // Fail loudly rather than returning "not found": an unscoped transaction is
    // a wiring mistake, and silently answering 404 would hide it.
    throw new Error('no tenant is bound to this transaction; run inside withTenant');
  }
  return issuerId;
}

/** A period, but only when it belongs to the transaction's issuer. */
async function loadOwnedPeriod(
  db: Queryable,
  periodId: string,
): Promise<ReportingPeriod | null> {
  const issuerId = await currentIssuerId(db);
  const period = await new PgReportStore(db).getPeriod(periodId);
  if (period === null || period.issuerId !== issuerId) return null;
  return period;
}

/** Convenience wrapper used by the routes. */
export async function requirePeriod(
  db: Queryable,
  periodId: string,
): Promise<ReportingPeriod> {
  const period = await loadOwnedPeriod(db, periodId);
  // "Not found" and "not yours" are deliberately indistinguishable: confirming
  // that a period id exists elsewhere is itself a disclosure.
  if (period === null) throw notFound(`period ${periodId} not found`);
  return period;
}

export async function requireVersion(db: Queryable, versionId: string): Promise<ReportVersion> {
  const version = await new PgReportStore(db).getVersion(versionId);
  // A report version carries no issuer of its own, so ownership is decided by
  // the period it belongs to.
  if (version === null || (await loadOwnedPeriod(db, version.periodId)) === null) {
    throw notFound(`report version ${versionId} not found`);
  }
  return version;
}
