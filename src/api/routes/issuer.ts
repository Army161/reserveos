import type { FastifyInstance } from 'fastify';
import { inTenant, requirePrincipal, type AppContext } from '../server.js';
import { PgCustodianStore, PgIssuerStore, PgTokenDeploymentStore } from '../../db/stores/reference.js';
import { PgSourceDocumentStore } from '../../db/stores/documents.js';
import { PgRedemptionStore } from '../../db/stores/workflow.js';
import { slaState } from '../../services/redemption.js';
import { notFound } from '../errors.js';

/** Identity, reference data, and operational visibility. */
export function registerIssuerRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/api/me', async (request) => {
    const principal = requirePrincipal(request);
    const issuer = await inTenant(context, request, (client, p) =>
      new PgIssuerStore(client).get(p.issuerId),
    );
    if (issuer === null) throw notFound('issuer not found');

    return {
      user: {
        id: principal.userId,
        email: principal.email,
        roles: principal.roles,
        stepUpVerified: principal.stepUpVerified,
      },
      issuer: {
        id: issuer.id,
        legalName: issuer.legalName,
        regulator: issuer.regulator,
        businessCalendar: issuer.businessCalendar,
      },
    };
  });

  app.get('/api/custodians', async (request) =>
    inTenant(context, request, async (client, p) => {
      const custodians = await new PgCustodianStore(client).listForIssuer(p.issuerId);
      return {
        custodians: custodians.map((custodian) => ({
          id: custodian.id,
          name: custodian.name,
          jurisdiction: custodian.jurisdiction,
          connectorType: custodian.connectorType,
          active: custodian.active,
          // `connectorConfig` is deliberately absent: it names credential
          // references and is of no use to a dashboard.
        })),
      };
    }),
  );

  app.get('/api/deployments', async (request) =>
    inTenant(context, request, async (client, p) => ({
      deployments: await new PgTokenDeploymentStore(client).listForIssuer(p.issuerId),
    })),
  );

  /** Ingestion audit: which files produced the current figures. */
  app.get('/api/documents', async (request) =>
    inTenant(context, request, async (client, p) => {
      const documents = await new PgSourceDocumentStore(client).listForIssuer(p.issuerId);
      return {
        documents: documents.map((document) => ({
          id: document.id,
          filename: document.filename,
          contentHash: document.contentHash,
          byteSize: document.byteSize.toString(),
          statementAsOf: document.statementAsOf?.toISOString() ?? null,
          rowCount: document.rowCount,
          status: document.status,
          rejectionReason: document.rejectionReason,
          ingestedAt: document.ingestedAt.toISOString(),
        })),
      };
    }),
  );

  /** Open redemptions with their live SLA state, for the operations view. */
  app.get('/api/redemptions/open', async (request) =>
    inTenant(context, request, async (client, p) => {
      const open = await new PgRedemptionStore(client).listOpen(p.issuerId);
      const now = context.now();
      return {
        redemptions: open.map((redemption) => ({
          id: redemption.id,
          externalRef: redemption.externalRef,
          requestedAt: redemption.requestedAt.toISOString(),
          amountUsd: formatMinor(redemption.amountMinor),
          slaDeadline: redemption.slaDeadline.toISOString(),
          status: redemption.status,
          slaState: slaState(redemption, now),
        })),
      };
    }),
  );
}

function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const cents = absolute % 100n;
  return `${negative ? '-' : ''}${whole}.${cents.toString().padStart(2, '0')}`;
}
