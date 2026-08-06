import type { KaleidoClient } from '../kaleido/client.js';
import type { EvidenceService } from './evidence.js';

/**
 * The certification workflow: Preparer → Compliance → CFO → CEO.
 *
 * Stage order is enforced here *and* in the Kaleido Policy Manager, so a single
 * compromised layer is not sufficient to produce an invalid certification.
 */

export const APPROVAL_ROLES = ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

/**
 * Exact wording shown to each signer and stored verbatim with the signature.
 *
 * The CFO and CEO text mirrors the statutory certification. Changing any of
 * these strings changes the meaning of an existing record, so they are versioned
 * constants and must never be edited in place — add a new version instead.
 */
export const ATTESTATION_TEXT: Record<ApprovalRole, string> = {
  PREPARER:
    'I prepared this reserve report from the source records identified in its lineage ' +
    'and confirm the figures reflect those records without adjustment.',
  COMPLIANCE:
    'I reviewed this reserve report against the applicable reserve composition, tenor ' +
    'and redemption requirements and confirm all exceptions are disclosed.',
  CFO:
    'I certify that this monthly reserve report is true and correct in all material ' +
    'respects and fairly presents the composition of reserves backing outstanding ' +
    'payment stablecoins as of the period end.',
  CEO:
    'I certify that this monthly reserve report is true and correct in all material ' +
    'respects and fairly presents the composition of reserves backing outstanding ' +
    'payment stablecoins as of the period end.',
};

/** Roles whose signature carries personal statutory liability. */
export const EXECUTIVE_ROLES: ReadonlySet<ApprovalRole> = new Set<ApprovalRole>(['CFO', 'CEO']);

export interface Approver {
  readonly id: string;
  readonly email: string;
  readonly roles: readonly ApprovalRole[];
  /** True when the current session completed a WebAuthn step-up. */
  readonly stepUpVerified: boolean;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly reportVersionId: string;
  readonly role: ApprovalRole;
  readonly actorId: string;
  readonly actorEmail: string;
  readonly decision: ApprovalDecision;
  readonly attestationText: string;
  readonly signature: string;
  readonly signedAt: Date;
  readonly pmsDecisionId: string;
}

export interface ApprovalStore {
  listForVersion(reportVersionId: string): Promise<ApprovalRecord[]>;
  insert(record: ApprovalRecord): Promise<void>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records: ApprovalRecord[] = [];

  async listForVersion(reportVersionId: string): Promise<ApprovalRecord[]> {
    return this.records.filter((r) => r.reportVersionId === reportVersionId);
  }

  async insert(record: ApprovalRecord): Promise<void> {
    const clash = this.records.find(
      (r) => r.reportVersionId === record.reportVersionId && r.role === record.role,
    );
    if (clash !== undefined) {
      throw new CertificationError(`${record.role} has already decided on this version`);
    }
    this.records.push(record);
  }
}

export class CertificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificationError';
  }
}

/** Signs `payloadHash` bound to the attestation wording the signer saw. */
export type Signer = (params: {
  actor: Approver;
  payloadHash: string;
  attestationText: string;
}) => Promise<string>;

export interface CertificationServiceOptions {
  readonly approvals: ApprovalStore;
  readonly kaleido: KaleidoClient;
  readonly evidence: EvidenceService;
  readonly sign: Signer;
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface SubmitApprovalParams {
  readonly issuerId: string;
  readonly reportVersionId: string;
  readonly payloadHash: string;
  readonly actor: Approver;
  readonly role: ApprovalRole;
  readonly decision: ApprovalDecision;
  /** True when the computed period still has an unresolved CRITICAL breach. */
  readonly hasCriticalBreach: boolean;
  /**
   * Commitment anchored for the report version on final certification.
   *
   * Defaults to `payloadHash`. Callers that also publish a derived public
   * disclosure should pass `merkleRoot([payloadHash, disclosureHash])` so the
   * single on-chain commitment covers both documents — otherwise the published
   * figures themselves are not tamper-evident to anyone without the full report.
   */
  readonly versionCommitment?: string;
}

export interface SubmitApprovalResult {
  readonly approval: ApprovalRecord;
  /** True once the CEO has approved and the period is fully certified. */
  readonly certified: boolean;
}

/** The stage a chain in this state is waiting on, or null when it is resolved. */
function nextRoleFrom(existing: readonly ApprovalRecord[]): ApprovalRole | null {
  if (existing.some((a) => a.decision === 'REJECTED')) return null;

  for (const role of APPROVAL_ROLES) {
    if (!existing.some((a) => a.role === role)) return role;
  }
  return null;
}

export class CertificationService {
  constructor(private readonly options: CertificationServiceOptions) {}

  /** The role expected to act next, or null when certification is complete. */
  async nextRole(reportVersionId: string): Promise<ApprovalRole | null> {
    return nextRoleFrom(await this.options.approvals.listForVersion(reportVersionId));
  }

  async submitApproval(params: SubmitApprovalParams): Promise<SubmitApprovalResult> {
    const { actor, role } = params;

    if (!actor.roles.includes(role)) {
      throw new CertificationError(`${actor.email} does not hold the ${role} role`);
    }

    // Read the chain once: the identity check and the stage check must agree on
    // the same snapshot, and asking twice would let them disagree.
    const existing = await this.options.approvals.listForVersion(params.reportVersionId);

    // Four eyes, not four roles on one pair.
    //
    // The stage check below only asks which ROLE signed last, so a user carrying
    // several roles — or anyone holding that user's token — could otherwise walk
    // PREPARER → COMPLIANCE → CFO → CEO alone and produce a report bearing four
    // statutory signatures with one human behind them. Both executive
    // attestations are personal criminal liability; they have to be personal.
    //
    // This belongs here rather than only in the HTTP route that happens to be
    // today's caller: the invariant is a property of the approval chain, and a
    // worker, a back-fill or the next route added would otherwise bypass it. The
    // durable backstop is a UNIQUE (report_version_id, actor_id) constraint on
    // `approvals`, which would also survive two concurrent requests; adding that
    // migration is out of this change's scope.
    const alreadyDecided = existing.find((approval) => approval.actorId === actor.id);
    if (alreadyDecided !== undefined) {
      throw new CertificationError(
        `${actor.email} already recorded a decision on this version as ` +
          `${alreadyDecided.role}; ${role} must be a different person`,
      );
    }

    // Someone is accepting personal criminal liability. A live session cookie is
    // not adequate evidence of intent, so re-verify presence at signing time.
    if (EXECUTIVE_ROLES.has(role) && !actor.stepUpVerified) {
      throw new CertificationError(`${role} certification requires step-up authentication`);
    }

    const expected = nextRoleFrom(existing);
    if (expected === null) {
      throw new CertificationError('this version is already resolved');
    }
    if (expected !== role) {
      throw new CertificationError(`out of order: ${expected} must act before ${role}`);
    }

    // A critical breach means a figure is known-wrong or known-noncompliant.
    // Refusing the signature is the whole point of detecting it.
    if (params.decision === 'APPROVED' && params.hasCriticalBreach) {
      throw new CertificationError(
        'cannot certify while a critical breach is unresolved; resolve it and regenerate',
      );
    }

    const policy = await this.options.kaleido.evaluatePolicy({
      policy: 'reserveos.certification',
      input: {
        role,
        actorId: actor.id,
        reportVersionId: params.reportVersionId,
        decision: params.decision,
      },
    });
    if (!policy.allowed) {
      throw new CertificationError(policy.reason ?? 'policy denied this approval');
    }

    const attestationText = ATTESTATION_TEXT[role];
    const signature = await this.options.sign({
      actor,
      payloadHash: params.payloadHash,
      attestationText,
    });

    const approval: ApprovalRecord = {
      id: this.options.newId(),
      reportVersionId: params.reportVersionId,
      role,
      actorId: actor.id,
      actorEmail: actor.email,
      decision: params.decision,
      attestationText,
      signature,
      signedAt: this.options.now(),
      pmsDecisionId: policy.decisionId,
    };

    await this.options.approvals.insert(approval);

    await this.options.evidence.anchor({
      issuerId: params.issuerId,
      subjectType: 'APPROVAL',
      subjectId: approval.id,
      merkleRoot: params.payloadHash,
    });

    const certified = role === 'CEO' && params.decision === 'APPROVED';
    if (certified) {
      await this.options.evidence.anchor({
        issuerId: params.issuerId,
        subjectType: 'REPORT_VERSION',
        subjectId: params.reportVersionId,
        merkleRoot: params.versionCommitment ?? params.payloadHash,
      });
    }

    return { approval, certified };
  }
}
