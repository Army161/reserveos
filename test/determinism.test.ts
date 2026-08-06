import { describe, expect, it } from 'vitest';
import { computePeriod } from '../src/domain/reconciliation.js';
import { buildPublicDisclosure, buildReport } from '../src/domain/report.js';
import { baselineScenario, ISSUER_ID, PERIOD_END, PERIOD_START } from './fixtures.js';

/**
 * The determinism guarantee.
 *
 * If any of these fail, independent verification of a certified report is broken
 * and the product's core claim no longer holds. Treat a failure here as a release
 * blocker, never as a test to update.
 */

const ISSUER = {
  id: ISSUER_ID,
  legalName: 'Acme Digital Trust Company, N.A.',
  regulator: 'OCC',
};

const REDEMPTIONS = {
  requestCount: 412,
  settledCount: 410,
  breachedCount: 0,
  medianSettlementMinutes: 47,
};

const GENERATED_AT = new Date('2026-04-02T14:30:00.000Z');

function assemble(scenario = baselineScenario()) {
  return buildReport({
    issuer: ISSUER,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    computation: computePeriod(scenario),
    redemptions: REDEMPTIONS,
    fxSource: 'test-fixture',
    generatedAt: GENERATED_AT,
  });
}

describe('determinism', () => {
  it('produces an identical hash across repeated runs', () => {
    const hashes = new Set(Array.from({ length: 25 }, () => assemble().payloadHash));
    expect(hashes.size).toBe(1);
  });

  it('is invariant to the input order of reserve facts', () => {
    const base = baselineScenario();
    const shuffled = { ...base, facts: [...base.facts].reverse() };
    expect(assemble(shuffled).payloadHash).toBe(assemble(base).payloadHash);
  });

  it('is invariant to the input order of supply facts', () => {
    const base = baselineScenario();
    const shuffled = { ...base, supplyFacts: [...base.supplyFacts].reverse() };
    expect(assemble(shuffled).payloadHash).toBe(assemble(base).payloadHash);
  });

  it('is invariant to the input order of custodians and deployments', () => {
    const base = baselineScenario();
    const shuffled = {
      ...base,
      custodians: [...base.custodians].reverse(),
      deployments: [...base.deployments].reverse(),
    };
    expect(assemble(shuffled).payloadHash).toBe(assemble(base).payloadHash);
  });

  it('pins the baseline hash so an accidental format change is caught', () => {
    // Regenerate deliberately if the schema version changes; never "to make it pass".
    expect(assemble().payloadHash).toMatchInlineSnapshot(
      `"d0d13f3f26ed38ee2953261462424d8558d4574933802fc5491810a45f152f1c"`,
    );
  });

  it('changes the hash when a single cent moves', () => {
    const base = baselineScenario();
    const first = base.facts[0]!;
    const nudged = {
      ...base,
      facts: [{ ...first, marketValueMinor: first.marketValueMinor + 1n }, ...base.facts.slice(1)],
    };
    expect(assemble(nudged).payloadHash).not.toBe(assemble(base).payloadHash);
  });

  it('changes the hash when the generation time changes', () => {
    const base = baselineScenario();
    const later = buildReport({
      issuer: ISSUER,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      computation: computePeriod(base),
      redemptions: REDEMPTIONS,
      fxSource: 'test-fixture',
      generatedAt: new Date('2026-04-02T14:30:00.001Z'),
    });
    expect(later.payloadHash).not.toBe(assemble(base).payloadHash);
  });

  it('never reads the system clock, so a historical report regenerates identically', () => {
    const first = assemble();
    // Simulate time passing between the original run and a later reproduction.
    const originalNow = Date.now;
    try {
      Date.now = () => new Date('2027-01-01T00:00:00.000Z').getTime();
      expect(assemble().payloadHash).toBe(first.payloadHash);
    } finally {
      Date.now = originalNow;
    }
  });

  it('derives the public disclosure deterministically and binds it to the full report', () => {
    const full = assemble();
    const publicA = buildPublicDisclosure(full);
    const publicB = buildPublicDisclosure(full);
    expect(publicA.payloadHash).toBe(publicB.payloadHash);
    expect(publicA.payloadHash).not.toBe(full.payloadHash);
    expect((publicA.payload as Record<string, unknown>)['certifiedReportHash']).toBe(
      full.payloadHash,
    );
  });

  it('omits internal lineage from the public disclosure', () => {
    const publicPayload = buildPublicDisclosure(assemble()).payload as Record<string, unknown>;
    expect(publicPayload['lineage']).toBeUndefined();
    expect(publicPayload['breaches']).toBeUndefined();
  });
});
