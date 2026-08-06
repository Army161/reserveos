import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  inTenant,
  parseBody,
  requireRole,
  requireUuid,
  type AppContext,
} from '../server.js';
import { PgReportStore } from '../../db/stores/reports.js';
import {
  endOfDay,
  generateReportVersion,
  loadComputation,
  publishPeriod,
  requirePeriod,
  requireVersion,
} from '../../services/period.js';
import { formatMinor, formatRatio } from '../../domain/money.js';
import type { PeriodComputation } from '../../domain/types.js';
import { conflict } from '../errors.js';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()), 'is not a real date');

const openPeriodSchema = z
  .object({ periodStart: isoDate, periodEnd: isoDate })
  .refine((body) => body.periodEnd >= body.periodStart, {
    message: 'periodEnd must not precede periodStart',
    path: ['periodEnd'],
  });

export function registerPeriodRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/api/periods', async (request) =>
    inTenant(context, request, async (client, p) => {
      const { rows } = await client.query<{
        id: string;
        period_start: Date;
        period_end: Date;
        status: string;
        created_at: Date;
      }>(
        `SELECT id, period_start, period_end, status, created_at
           FROM reporting_periods WHERE issuer_id = $1 ORDER BY period_end DESC`,
        [p.issuerId],
      );
      return {
        periods: rows.map((row) => ({
          id: row.id,
          periodStart: row.period_start.toISOString().slice(0, 10),
          periodEnd: row.period_end.toISOString().slice(0, 10),
          status: row.status,
          createdAt: row.created_at.toISOString(),
        })),
      };
    }),
  );

  app.post('/api/periods', async (request, reply) => {
    requireRole(request, 'PREPARER');
    const body = parseBody(openPeriodSchema, request.body);

    const period = await inTenant(context, request, (client, p) =>
      new PgReportStore(client).openPeriod(p.issuerId, body.periodStart, body.periodEnd),
    );

    void reply.status(201);
    return {
      id: period.id,
      periodStart: period.periodStart.toISOString().slice(0, 10),
      periodEnd: period.periodEnd.toISOString().slice(0, 10),
      status: period.status,
    };
  });

  app.get<{ Params: { id: string } }>('/api/periods/:id', async (request) => {
    const periodId = requireUuid(request.params.id, 'period id');
    return inTenant(context, request, async (client) => {
      const period = await requirePeriod(client, periodId);
      const versions = await new PgReportStore(client).listVersions(period.id);
      return {
        id: period.id,
        periodStart: period.periodStart.toISOString().slice(0, 10),
        periodEnd: period.periodEnd.toISOString().slice(0, 10),
        status: period.status,
        versions: versions.map((version) => ({
          id: version.id,
          version: version.version,
          payloadHash: version.payloadHash,
          generatedAt: version.generatedAt.toISOString(),
        })),
      };
    });
  });

  /**
   * The live reconciliation view.
   *
   * Recomputed from stored facts on every call rather than cached: a stale
   * collateralization ratio on a compliance dashboard is worse than a slow one.
   */
  app.get<{ Params: { id: string } }>('/api/periods/:id/computation', async (request) => {
    const periodId = requireUuid(request.params.id, 'period id');
    return inTenant(context, request, async (client, p) => {
      const period = await requirePeriod(client, periodId);
      const computation = await loadComputation(
        client,
        p.issuerId,
        endOfDay(period.periodEnd),
        context.fxSource,
      );
      return presentComputation(computation);
    });
  });

  app.post<{ Params: { id: string } }>('/api/periods/:id/report', async (request, reply) => {
    requireRole(request, 'PREPARER');
    const periodId = requireUuid(request.params.id, 'period id');

    const result = await inTenant(context, request, async (client, p) => {
      const period = await requirePeriod(client, periodId);
      if (period.status === 'PUBLISHED') {
        throw conflict('a published period cannot be regenerated');
      }
      return generateReportVersion(client, {
        issuerId: p.issuerId,
        period,
        generatedBy: p.userId,
        generatedAt: context.now(),
        fxSource: context.fxSource,
      });
    });

    void reply.status(201);
    return {
      versionId: result.version.id,
      version: result.version.version,
      payloadHash: result.report.payloadHash,
      generatedAt: result.version.generatedAt.toISOString(),
      // Surfaced so the UI can block the certification button rather than
      // letting a signer discover the problem at the signature step.
      criticalBreaches: result.computation.breaches.filter((b) => b.severity === 'CRITICAL').length,
    };
  });

  app.get<{ Params: { id: string } }>('/api/reports/:id', async (request) => {
    const versionId = requireUuid(request.params.id, 'report version id');
    return inTenant(context, request, async (client) => {
      // `requireVersion` checks that the version's period belongs to the caller.
      // Reading the row by primary key is not enough on its own: see the note
      // there on why RLS lets a published row through for any tenant.
      const version = await requireVersion(client, versionId);
      const approvals = await client.query<{ role: string; decision: string; signed_at: Date }>(
        `SELECT role, decision, signed_at FROM approvals WHERE report_version_id = $1
          ORDER BY signed_at, id`,
        [versionId],
      );
      return {
        id: version.id,
        periodId: version.periodId,
        version: version.version,
        payloadHash: version.payloadHash,
        generatedAt: version.generatedAt.toISOString(),
        payload: version.payload,
        approvals: approvals.rows.map((row) => ({
          role: row.role,
          decision: row.decision,
          signedAt: row.signed_at.toISOString(),
        })),
      };
    });
  });

  app.post<{ Params: { id: string } }>('/api/periods/:id/publish', async (request) => {
    requireRole(request, 'COMPLIANCE', 'CFO', 'CEO');
    const periodId = requireUuid(request.params.id, 'period id');

    return inTenant(context, request, async (client) => {
      const period = await requirePeriod(client, periodId);
      await publishPeriod(client, period);
      return { id: period.id, status: 'PUBLISHED' };
    });
  });
}

/**
 * Present a computation for the dashboard.
 *
 * Money crosses the wire as a decimal string, never a JSON number: a
 * ten-billion-token supply at 18 decimals exceeds `Number.MAX_SAFE_INTEGER` by
 * ten orders of magnitude, and `JSON.parse` in the browser would silently round
 * it.
 */
export function presentComputation(computation: PeriodComputation): unknown {
  return {
    asOf: computation.asOf.toISOString(),
    totalReserveValueUsd: formatMinor(computation.totalReserveValueMinor),
    totalOutstandingUsd: formatMinor(computation.totalOutstandingMinor),
    collateralizationRatio:
      computation.collateralizationRatioBps === null
        ? null
        : formatRatio(BigInt(computation.collateralizationRatioBps), 10_000n, 4),
    composition: [...computation.compositionByCategory].map(([category, breakdown]) => ({
      category,
      marketValueUsd: formatMinor(breakdown.marketValueMinor),
      percentOfTotal: formatRatio(BigInt(breakdown.percentOfTotalBps), 100n, 2),
      weightedAverageTenorDays: breakdown.weightedAverageTenorDays,
    })),
    custodyByJurisdiction: [...computation.custodyByJurisdiction].map(([jurisdiction, amount]) => ({
      jurisdiction,
      marketValueUsd: formatMinor(amount),
    })),
    outstandingByChain: computation.supplyByChain.map((chain) => ({
      chainId: chain.chainId,
      contractAddress: chain.contractAddress,
      outstandingUsd: formatMinor(chain.outstandingMinor),
      totalSupplyRaw: chain.totalSupply.toString(),
      blockNumber: chain.blockNumber.toString(),
      blockTimestamp: chain.blockTimestamp.toISOString(),
    })),
    breaches: computation.breaches.map((breach) => ({
      code: breach.code,
      severity: breach.severity,
      detail: breach.detail,
      subjects: breach.subjects,
    })),
  };
}
