import { beforeEach, describe, expect, it } from 'vitest';
import { FakeKaleidoClient } from '../src/kaleido/fake.js';
import { EvidenceService, InMemoryAnchorStore } from '../src/services/evidence.js';
import {
  ATTESTATION_TEXT,
  CertificationError,
  CertificationService,
  InMemoryApprovalStore,
  type ApprovalRole,
  type Approver,
} from '../src/services/certification.js';

const PAYLOAD_HASH = 'a'.repeat(64);
const VERSION_ID = '44444444-4444-4444-4444-444444444444';
const ISSUER_ID = '11111111-1111-1111-1111-111111111111';

function approver(role: ApprovalRole, stepUpVerified = true): Approver {
  return {
    id: `user-${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@acme.test`,
    roles: [role],
    stepUpVerified,
  };
}

describe('CertificationService', () => {
  let kaleido: FakeKaleidoClient;
  let anchors: InMemoryAnchorStore;
  let approvals: InMemoryApprovalStore;
  let service: CertificationService;
  let idCounter: number;

  beforeEach(() => {
    kaleido = new FakeKaleidoClient();
    anchors = new InMemoryAnchorStore();
    approvals = new InMemoryApprovalStore();
    idCounter = 0;
    const newId = () => `id-${++idCounter}`;

    service = new CertificationService({
      approvals,
      kaleido,
      evidence: new EvidenceService({ store: anchors, kaleido, newId }),
      sign: async ({ payloadHash, attestationText }) =>
        `sig(${payloadHash.slice(0, 8)}|${attestationText.slice(0, 12)})`,
      newId,
      now: () => new Date('2026-04-02T15:00:00.000Z'),
    });
  });

  async function approve(role: ApprovalRole, overrides: Partial<{ hasCriticalBreach: boolean }> = {}) {
    return service.submitApproval({
      issuerId: ISSUER_ID,
      reportVersionId: VERSION_ID,
      payloadHash: PAYLOAD_HASH,
      actor: approver(role),
      role,
      decision: 'APPROVED',
      hasCriticalBreach: overrides.hasCriticalBreach ?? false,
    });
  }

  it('walks the full chain and certifies on CEO approval', async () => {
    expect(await service.nextRole(VERSION_ID)).toBe('PREPARER');

    expect((await approve('PREPARER')).certified).toBe(false);
    expect((await approve('COMPLIANCE')).certified).toBe(false);
    expect((await approve('CFO')).certified).toBe(false);

    const final = await approve('CEO');
    expect(final.certified).toBe(true);
    expect(await service.nextRole(VERSION_ID)).toBeNull();
  });

  it('rejects out-of-order approval', async () => {
    await expect(approve('CEO')).rejects.toThrow(/PREPARER must act before CEO/);
  });

  it('rejects a role the actor does not hold', async () => {
    await expect(
      service.submitApproval({
        issuerId: ISSUER_ID,
        reportVersionId: VERSION_ID,
        payloadHash: PAYLOAD_HASH,
        actor: { ...approver('PREPARER'), roles: ['COMPLIANCE'] },
        role: 'PREPARER',
        decision: 'APPROVED',
        hasCriticalBreach: false,
      }),
    ).rejects.toThrow(/does not hold the PREPARER role/);
  });

  it('requires step-up authentication for executive certification', async () => {
    await approve('PREPARER');
    await approve('COMPLIANCE');

    await expect(
      service.submitApproval({
        issuerId: ISSUER_ID,
        reportVersionId: VERSION_ID,
        payloadHash: PAYLOAD_HASH,
        actor: approver('CFO', false),
        role: 'CFO',
        decision: 'APPROVED',
        hasCriticalBreach: false,
      }),
    ).rejects.toThrow(/requires step-up authentication/);
  });

  it('does not require step-up for non-executive roles', async () => {
    await expect(
      service.submitApproval({
        issuerId: ISSUER_ID,
        reportVersionId: VERSION_ID,
        payloadHash: PAYLOAD_HASH,
        actor: approver('PREPARER', false),
        role: 'PREPARER',
        decision: 'APPROVED',
        hasCriticalBreach: false,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses to certify while a critical breach is open', async () => {
    await expect(approve('PREPARER', { hasCriticalBreach: true })).rejects.toThrow(
      /critical breach is unresolved/,
    );
  });

  it('allows rejection even when a critical breach is open', async () => {
    const result = await service.submitApproval({
      issuerId: ISSUER_ID,
      reportVersionId: VERSION_ID,
      payloadHash: PAYLOAD_HASH,
      actor: approver('PREPARER'),
      role: 'PREPARER',
      decision: 'REJECTED',
      hasCriticalBreach: true,
    });
    expect(result.approval.decision).toBe('REJECTED');
  });

  it('halts the chain after a rejection', async () => {
    await service.submitApproval({
      issuerId: ISSUER_ID,
      reportVersionId: VERSION_ID,
      payloadHash: PAYLOAD_HASH,
      actor: approver('PREPARER'),
      role: 'PREPARER',
      decision: 'REJECTED',
      hasCriticalBreach: false,
    });
    expect(await service.nextRole(VERSION_ID)).toBeNull();
    await expect(approve('COMPLIANCE')).rejects.toThrow(/already resolved/);
  });

  it('honours a Policy Manager denial even when local checks pass', async () => {
    kaleido.setPolicy(false, 'segregation of duties violation');
    await expect(approve('PREPARER')).rejects.toThrow(/segregation of duties/);
  });

  it('stores the exact attestation wording shown to the signer', async () => {
    await approve('PREPARER');
    await approve('COMPLIANCE');
    const { approval } = await approve('CFO');
    expect(approval.attestationText).toBe(ATTESTATION_TEXT.CFO);
    expect(approval.attestationText).toMatch(/true and correct in all material respects/);
  });

  it('binds the signature to the payload hash, not to a description of it', async () => {
    const { approval } = await approve('PREPARER');
    expect(approval.signature).toContain(PAYLOAD_HASH.slice(0, 8));
  });

  it('records the Policy Manager decision id for the audit trail', async () => {
    const { approval } = await approve('PREPARER');
    expect(approval.pmsDecisionId).toMatch(/^pms-/);
  });

  it('anchors every approval, plus the report version on certification', async () => {
    await approve('PREPARER');
    await approve('COMPLIANCE');
    await approve('CFO');
    await approve('CEO');

    const all = await anchors.all();
    expect(all.filter((a) => a.subjectType === 'APPROVAL')).toHaveLength(4);
    expect(all.filter((a) => a.subjectType === 'REPORT_VERSION')).toHaveLength(1);
    expect(all.every((a) => a.status === 'CONFIRMED')).toBe(true);
  });

  it('prevents the same role deciding twice on one version', async () => {
    await approve('PREPARER');
    await expect(
      service.submitApproval({
        issuerId: ISSUER_ID,
        reportVersionId: VERSION_ID,
        payloadHash: PAYLOAD_HASH,
        actor: approver('PREPARER'),
        role: 'PREPARER',
        decision: 'APPROVED',
        hasCriticalBreach: false,
      }),
    ).rejects.toThrow(CertificationError);
  });
});
