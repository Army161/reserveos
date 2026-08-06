import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, parseBody, requirePrincipal, requireUuid, type AppContext } from '../server.js';
import { PgAnchorStore, PgApprovalStore } from '../../db/stores/workflow.js';
import { PgReportStore } from '../../db/stores/reports.js';
import { EvidenceService } from '../../services/evidence.js';
import {
  ATTESTATION_TEXT,
  CertificationError,
  CertificationService,
  EXECUTIVE_ROLES,
  type ApprovalRole,
} from '../../services/certification.js';
import {
  requirePeriod,
  requireVersion,
  reproduceVersion,
  StaleVersionError,
} from '../../services/period.js';
import { buildPublicDisclosure, hasCriticalBreach } from '../../domain/report.js';
import { merkleRoot, type CanonicalValue } from '../../domain/canonical.js';
import { conflict, forbidden, unprocessable } from '../errors.js';

const approvalSchema = z.object({
  role: z.enum(['PREPARER', 'COMPLIANCE', 'CFO', 'CEO']),
  decision: z.enum(['APPROVED', 'REJECTED']),
});

export function registerCertificationRoutes(app: FastifyInstance, context: AppContext): void {
  /**
   * Record a certification decision.
   *
   * The critical-breach check recomputes from stored facts rather than trusting
   * a flag captured when the report was generated: facts can arrive between
   * generation and signing, and the question a signer is answering is whether
   * the figures are correct *now*.
   *
   * That premise is right, but recomputing alone does not establish it. A
   * signature binds `version.payload`, the snapshot taken at generation. Gating
   * on a fresh computation without checking it against that snapshot asks the
   * question of one document and records the answer against another, and the
   * two diverge the moment a corrected statement or a late supply observation
   * lands — the ordinary month-end flow. A version generated with a CRITICAL
   * breach in it could then be signed by all four roles, anchored and published,
   * because the gate was looking at cleaner figures than the ones on the page.
   *
   * `reproduceVersion` closes that by replaying the assembly and comparing
   * hashes, so "correct now" and "what you are signing" are the same document or
   * the request is refused.
   */
  app.post<{ Params: { id: string } }>('/api/reports/:id/approvals', async (request, reply) => {
    // Establish who is asking before touching anything they sent. Parsing first
    // answered an anonymous caller with a 400 describing the approval schema —
    // no data escaped, but "here is the shape of a certification request" is not
    // a reply an unauthenticated request has earned, and 401 is the honest one.
    const principal = requirePrincipal(request);
    const versionId = requireUuid(request.params.id, 'report version id');
    const body = parseBody(approvalSchema, request.body);
    const role = body.role as ApprovalRole;

    if (!principal.roles.includes(role)) {
      throw forbidden(`you do not hold the ${role} role`);
    }

    const result = await inTenant(context, request, async (client, p) => {
      const version = await requireVersion(client, versionId);
      const period = await requirePeriod(client, version.periodId);

      if (period.status === 'PUBLISHED') {
        throw conflict('a published period cannot be re-certified');
      }

      // Certify only the latest version: signing a superseded one would attach a
      // statutory certification to figures the issuer has already replaced.
      const latest = await new PgReportStore(client).getLatestVersion(period.id);
      if (latest === null || latest.id !== version.id) {
        throw conflict(
          `report version ${version.version} has been superseded by version ${latest?.version}`,
        );
      }

      // Four eyes, not four roles on one pair.
      //
      // The chain's stated value is that "a single compromised layer is not
      // sufficient", but the stage check only asks which ROLE signed last. A
      // user carrying several roles — or anyone holding that user's token —
      // could otherwise walk PREPARER → COMPLIANCE → CFO → CEO alone and emit a
      // report bearing four statutory signatures with one human behind them.
      // Both executive attestations are personal criminal liability; they have
      // to be personal.
      const priorApprovals = await new PgApprovalStore(client).listForVersion(version.id);
      const alreadySigned = priorApprovals.find((approval) => approval.actorId === p.userId);
      if (alreadySigned !== undefined) {
        throw forbidden(
          `you already signed this report version as ${alreadySigned.role}; ` +
            `${role} must be a different person`,
        );
      }

      // Refuse to CERTIFY a version the facts have moved out from under. Same
      // principle as the superseded-version guard above — that one asks whether
      // a NEWER version exists, this one whether THIS version is still true —
      // and it is what makes the breach gate below meaningful, since once it
      // passes the recomputed figures are the signed figures.
      //
      // Approvals only. A rejection is someone saying the report is wrong, and
      // a report whose facts have moved is exactly the kind that ought to be
      // rejectable; refusing that would leave a stale version with no way out
      // but to regenerate around it, and would silence the reviewer whose
      // objection is most likely to be right. Same reasoning as the critical
      // breach gate below, which is also `decision === 'APPROVED'` only.
      let computation = null;
      if (body.decision === 'APPROVED') {
        try {
          computation = (
            await reproduceVersion(client, {
              issuerId: p.issuerId,
              period,
              version,
              fxSource: context.fxSource,
            })
          ).computation;
        } catch (error) {
          if (error instanceof StaleVersionError) throw conflict(error.message);
          throw error;
        }
      }

      const evidence = new EvidenceService({
        store: new PgAnchorStore(client),
        kaleido: context.kaleido,
        newId: () => randomUUID(),
      });

      const certification = new CertificationService({
        approvals: new PgApprovalStore(client),
        kaleido: context.kaleido,
        evidence,
        // The signature binds the payload hash to the attestation wording the
        // signer was shown. A real deployment routes this to the Kaleido Key
        // Manager so the private key never reaches this process.
        sign: async ({ actor, payloadHash, attestationText }) =>
          `reserveos-v1:${actor.id}:${payloadHash}:${hashWording(attestationText)}`,
        newId: () => randomUUID(),
        now: context.now,
      });

      // Commit to the report AND to the disclosure derived from it, so the
      // published figures are tamper-evident to a member of the public who will
      // never see the full report. See routes/verify.ts for the check an
      // examiner performs.
      const disclosure = buildPublicDisclosure({
        payload: version.payload as CanonicalValue,
        payloadHash: version.payloadHash,
        canonicalJson: '',
      });
      const versionCommitment = merkleRoot([version.payloadHash, disclosure.payloadHash]);

      try {
        const outcome = await certification.submitApproval({
          issuerId: p.issuerId,
          reportVersionId: version.id,
          payloadHash: version.payloadHash,
          versionCommitment,
          actor: {
            id: p.userId,
            email: p.email,
            roles: [role],
            stepUpVerified: p.stepUpVerified,
          },
          role,
          decision: body.decision,
          // Null only on a rejection, where the service does not consult it.
          hasCriticalBreach: computation !== null && hasCriticalBreach(computation),
        });

        if (outcome.certified) {
          await new PgReportStore(client).setPeriodStatus(period.id, 'CERTIFIED');
        } else if (period.status === 'OPEN') {
          await new PgReportStore(client).setPeriodStatus(period.id, 'IN_REVIEW');
        }

        await client.query(
          `INSERT INTO access_log (issuer_id, actor_id, actor_email, action, resource, detail)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            p.issuerId,
            p.userId,
            p.email,
            `certification.${body.decision.toLowerCase()}`,
            `report_version:${version.id}`,
            JSON.stringify({ role, payloadHash: version.payloadHash }),
          ],
        );

        return { outcome, version };
      } catch (error) {
        // A refused signature is the system working, not a fault: map it to a
        // status the UI can present rather than a 500.
        if (error instanceof CertificationError) throw unprocessable(error.message);
        throw error;
      }
    });

    void reply.status(201);
    return {
      approvalId: result.outcome.approval.id,
      role: result.outcome.approval.role,
      decision: result.outcome.approval.decision,
      attestationText: result.outcome.approval.attestationText,
      signedAt: result.outcome.approval.signedAt.toISOString(),
      certified: result.outcome.certified,
    };
  });

  app.get<{ Params: { id: string } }>('/api/reports/:id/approvals', async (request) => {
    requirePrincipal(request);
    const versionId = requireUuid(request.params.id, 'report version id');
    return inTenant(context, request, async (client) => {
      const approvals = await new PgApprovalStore(client).listForVersion(versionId);
      const certification = new CertificationService({
        approvals: new PgApprovalStore(client),
        kaleido: context.kaleido,
        evidence: new EvidenceService({
          store: new PgAnchorStore(client),
          kaleido: context.kaleido,
          newId: () => randomUUID(),
        }),
        sign: async () => '',
        newId: () => randomUUID(),
        now: context.now,
      });

      const nextRole = await certification.nextRole(versionId);

      return {
        approvals: approvals.map((approval) => ({
          role: approval.role,
          actorEmail: approval.actorEmail,
          decision: approval.decision,
          attestationText: approval.attestationText,
          signedAt: approval.signedAt.toISOString(),
        })),
        nextRole,
        /**
         * The wording the next signer is being asked to make, served from the
         * same constant that gets stored verbatim with the signature.
         *
         * The console shows this before enabling the sign button and refuses to
         * sign without it. Duplicating the text client-side would be easier and
         * would eventually drift from what the signature actually attests to —
         * and the whole point of storing the wording is that the record shows
         * what the signer really saw.
         */
        attestationText: nextRole === null ? null : ATTESTATION_TEXT[nextRole],
        /** Roles whose signature carries personal statutory liability. */
        requiresStepUp: nextRole !== null && EXECUTIVE_ROLES.has(nextRole),
      };
    });
  });

  /**
   * Record a completed step-up.
   *
   * Stands in for a WebAuthn assertion: a deployment verifies the authenticator
   * response here before stamping the token. Executive signing checks freshness
   * of this stamp, not merely that a session exists.
   */
  app.post('/api/auth/step-up', async (request) => {
    const principal = requirePrincipal(request);
    await context.authenticator.recordStepUp(principal.tokenId);
    return { stepUpVerified: true, validForSeconds: 300 };
  });
}

/** Short digest of the attestation wording, bound into the signature. */
function hashWording(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
