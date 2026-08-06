import { describe, expect, it } from 'vitest';
import { computePeriod } from '../src/domain/reconciliation.js';
import { buildPublicDisclosure, buildReport, hasCriticalBreach } from '../src/domain/report.js';
import { canonicalHash, sha256Hex } from '../src/domain/canonical.js';
import { US_FEDERAL } from '../src/domain/calendar.js';
import { FakeKaleidoClient } from '../src/kaleido/fake.js';
import { EvidenceService, InMemoryAnchorStore } from '../src/services/evidence.js';
import {
  CertificationService,
  InMemoryApprovalStore,
  type ApprovalRole,
} from '../src/services/certification.js';
import { openRequest, settle, summarize } from '../src/services/redemption.js';
import { baselineScenario, ISSUER_ID, PERIOD_END, PERIOD_START } from './fixtures.js';

/**
 * The V1 definition of done, exercised end to end:
 * ingest -> reconcile -> assemble -> certify -> anchor -> independently verify.
 */
describe('monthly cycle, end to end', () => {
  it('runs a full period from facts to an independently verifiable certified report', async () => {
    const kaleido = new FakeKaleidoClient();
    const anchorStore = new InMemoryAnchorStore();
    let counter = 0;
    const newId = () => `id-${++counter}`;

    const evidence = new EvidenceService({ store: anchorStore, kaleido, newId });

    // --- 1. Daily rollups anchored during the period ---------------------
    const scenario = baselineScenario();
    const factHashes = scenario.facts.map((f) => sha256Hex(`${f.id}:${f.marketValueMinor}`));
    const rollup = await evidence.anchorDailyRollup({
      issuerId: ISSUER_ID,
      rollupId: '77777777-7777-7777-7777-777777777777',
      factHashes,
    });
    expect(rollup.status).toBe('CONFIRMED');

    // --- 2. Redemption activity ------------------------------------------
    const redemptions = [
      settle(
        openRequest({
          id: 'r1',
          issuerId: ISSUER_ID,
          externalRef: 'REQ-1',
          requestedAt: new Date('2026-03-10T10:00:00Z'),
          amountMinor: 500_000_00n,
          calendar: US_FEDERAL,
        }),
        new Date('2026-03-11T09:00:00Z'),
      ),
      settle(
        openRequest({
          id: 'r2',
          issuerId: ISSUER_ID,
          externalRef: 'REQ-2',
          requestedAt: new Date('2026-03-17T10:00:00Z'),
          amountMinor: 250_000_00n,
          calendar: US_FEDERAL,
        }),
        new Date('2026-03-18T14:30:00Z'),
      ),
    ];
    const redemptionSummary = summarize(redemptions);
    expect(redemptionSummary.breachedCount).toBe(0);

    // --- 3. Reconcile the period ------------------------------------------
    const computation = computePeriod(scenario);
    expect(hasCriticalBreach(computation)).toBe(false);
    expect(computation.collateralizationRatioBps).toBe(10_500);

    // --- 4. Assemble the report -------------------------------------------
    const report = buildReport({
      issuer: {
        id: ISSUER_ID,
        legalName: 'Acme Digital Trust Company, N.A.',
        regulator: 'OCC',
      },
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      computation,
      redemptions: redemptionSummary,
      fxSource: 'test-fixture',
      generatedAt: new Date('2026-04-02T14:30:00.000Z'),
    });

    // --- 5. Certify through all four stages --------------------------------
    const certification = new CertificationService({
      approvals: new InMemoryApprovalStore(),
      kaleido,
      evidence,
      sign: async ({ actor, payloadHash }) => `sig:${actor.id}:${payloadHash}`,
      newId,
      now: () => new Date('2026-04-02T15:00:00.000Z'),
    });

    const versionId = '88888888-8888-8888-8888-888888888888';
    let certified = false;
    for (const role of ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'] as ApprovalRole[]) {
      const result = await certification.submitApproval({
        issuerId: ISSUER_ID,
        reportVersionId: versionId,
        payloadHash: report.payloadHash,
        actor: {
          id: `user-${role}`,
          email: `${role.toLowerCase()}@acme.test`,
          roles: [role],
          stepUpVerified: true,
        },
        role,
        decision: 'APPROVED',
        hasCriticalBreach: hasCriticalBreach(computation),
      });
      certified = result.certified;
    }
    expect(certified).toBe(true);

    // --- 6. Everything is anchored ------------------------------------------
    const anchors = await anchorStore.all();
    expect(anchors.filter((a) => a.subjectType === 'DAILY_ROLLUP')).toHaveLength(1);
    expect(anchors.filter((a) => a.subjectType === 'APPROVAL')).toHaveLength(4);
    expect(anchors.filter((a) => a.subjectType === 'REPORT_VERSION')).toHaveLength(1);
    expect(anchors.every((a) => a.status === 'CONFIRMED')).toBe(true);

    const versionAnchor = anchors.find((a) => a.subjectType === 'REPORT_VERSION')!;
    expect(versionAnchor.merkleRoot).toBe(report.payloadHash);

    // --- 7. Independent verification ----------------------------------------
    // An examiner recomputes the hash from the published payload alone and
    // compares it to the on-chain commitment. No trust in our servers required.
    const recomputed = canonicalHash(report.payload);
    expect(recomputed).toBe(versionAnchor.merkleRoot);

    // Tamper with one byte and verification must fail.
    const tampered = JSON.parse(report.canonicalJson) as Record<string, unknown>;
    (tampered['reserves'] as Record<string, unknown>)['totalMarketValueUsd'] = '10500000.01';
    expect(canonicalHash(tampered as never)).not.toBe(versionAnchor.merkleRoot);

    // --- 8. Public disclosure is bound to the certified report ---------------
    const publicDoc = buildPublicDisclosure(report);
    expect((publicDoc.payload as Record<string, unknown>)['certifiedReportHash']).toBe(
      report.payloadHash,
    );

    // --- 9. The external witness exists --------------------------------------
    expect(await kaleido.getLatestTetherProof()).not.toBeNull();
  });

  it('blocks certification when the period has a critical breach', async () => {
    const kaleido = new FakeKaleidoClient();
    let counter = 0;
    const newId = () => `id-${++counter}`;

    const scenario = baselineScenario();
    // Drop one chain's supply observation: outstanding would be understated.
    const computation = computePeriod({
      ...scenario,
      supplyFacts: scenario.supplyFacts.slice(0, 1),
    });
    expect(hasCriticalBreach(computation)).toBe(true);

    const certification = new CertificationService({
      approvals: new InMemoryApprovalStore(),
      kaleido,
      evidence: new EvidenceService({ store: new InMemoryAnchorStore(), kaleido, newId }),
      sign: async () => 'sig',
      newId,
      now: () => new Date('2026-04-02T15:00:00.000Z'),
    });

    await expect(
      certification.submitApproval({
        issuerId: ISSUER_ID,
        reportVersionId: '99999999-9999-9999-9999-999999999999',
        payloadHash: 'c'.repeat(64),
        actor: {
          id: 'user-prep',
          email: 'prep@acme.test',
          roles: ['PREPARER'],
          stepUpVerified: true,
        },
        role: 'PREPARER',
        decision: 'APPROVED',
        hasCriticalBreach: hasCriticalBreach(computation),
      }),
    ).rejects.toThrow(/critical breach is unresolved/);
  });
});
