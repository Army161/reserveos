/**
 * Generate a sample monthly reserve report from the test fixtures.
 *
 * Run: npm run demo
 */
import { computePeriod } from '../src/domain/reconciliation.js';
import { buildReport } from '../src/domain/report.js';
import { baselineScenario, ISSUER_ID, PERIOD_END, PERIOD_START } from '../test/fixtures.js';

const computation = computePeriod(baselineScenario());

const report = buildReport({
  issuer: {
    id: ISSUER_ID,
    legalName: 'Acme Digital Trust Company, N.A.',
    regulator: 'OCC',
  },
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  computation,
  redemptions: {
    requestCount: 412,
    settledCount: 412,
    breachedCount: 0,
    medianSettlementMinutes: 47,
  },
  fxSource: 'demo',
  generatedAt: new Date('2026-04-02T14:30:00.000Z'),
});

console.log(JSON.stringify(report.payload, null, 2));
console.log('\npayload_hash =', report.payloadHash);
console.log('breaches     =', computation.breaches.length);
