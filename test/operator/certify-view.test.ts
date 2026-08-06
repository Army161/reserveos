import { afterEach, describe, expect, it } from 'vitest';
import { bootConsole, byClass, installDom, type InstalledDom } from './dom.js';

/**
 * The certification screen, executed rather than grepped.
 *
 * This is the screen a CFO and a CEO sign a statutory filing from, and the
 * signature binds `report.payload` — the snapshot taken when the version was
 * generated. The screen used to render its figures from
 * `GET /api/periods/:id/computation`, which recomputes from whatever facts are
 * stored right now. Those two documents diverge as soon as a corrected custodian
 * statement or a late supply observation arrives, which is the ordinary
 * month-end flow, so the collateralization ratio printed directly beneath a
 * frozen payload hash could belong to a different document entirely.
 *
 * Every test here therefore builds a stored payload that DISAGREES with what any
 * live recomputation would say, and asserts the screen shows the stored one.
 */

const VERSION_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PERIOD_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/**
 * A payload whose figures are deliberately memorable and deliberately wrong.
 *
 * These are the numbers from the reproduction that found the defect: a version
 * generated while one chain's supply observation was missing, so outstanding is
 * understated and collateralization reads 150% when the true figure is 105%.
 */
const SIGNED_PAYLOAD = {
  schema: 'reserveos.report/v1',
  issuer: { id: 'issuer-1', legalName: 'Acme Digital Trust Company, N.A.', regulator: 'OCC' },
  period: { start: '2026-03-01', end: '2026-03-31', asOf: '2026-03-31T23:59:59.999Z' },
  generatedAt: '2026-04-02T14:30:00.000Z',
  reserves: { totalMarketValueUsd: '10500000.00', fxSource: 'ECB', composition: [] },
  outstanding: { totalUsd: '7000000.00', byChain: [] },
  collateralization: { ratio: '1.5000', ratioPercent: '150.00' },
  redemptions: {
    requestCount: '0',
    settledCount: '0',
    breachedCount: '0',
    medianSettlementMinutes: null,
  },
  breaches: [
    {
      code: 'NO_SUPPLY_OBSERVATION',
      severity: 'CRITICAL',
      detail: 'No supply observation at or before period end for ACME on chain 8453',
      subjects: ['33333333-3333-3333-3333-333333333332'],
    },
  ],
  lineage: { contributingFactIds: [] },
};

/** What a live recomputation would say. Nothing on this screen may show these. */
const LIVE_FIGURES = {
  collateralizationRatio: '1.0500',
  totalReserveValueUsd: '10500000.00',
  totalOutstandingUsd: '10000000.00',
  breaches: [],
};

interface Overrides {
  readonly payload?: unknown;
  readonly nextRole?: string | null;
  readonly roles?: string[];
  readonly stepUpVerified?: boolean;
  readonly approvals?: unknown[];
}

function routes(overrides: Overrides = {}): Record<string, unknown> {
  return {
    'GET /api/me': {
      issuer: { id: 'issuer-1', legalName: 'Acme Digital Trust Company, N.A.' },
      user: {
        email: 'ceo@acme.example',
        roles: overrides.roles ?? ['CEO'],
        stepUpVerified: overrides.stepUpVerified ?? true,
      },
    },
    [`GET /api/reports/${VERSION_ID}`]: {
      id: VERSION_ID,
      periodId: PERIOD_ID,
      version: 1,
      payloadHash: '9f'.repeat(32),
      generatedAt: '2026-04-02T14:30:00.000Z',
      payload: 'payload' in overrides ? overrides.payload : SIGNED_PAYLOAD,
      approvals: [],
    },
    [`GET /api/reports/${VERSION_ID}/approvals`]: {
      nextRole: overrides.nextRole === undefined ? 'CEO' : overrides.nextRole,
      approvals: overrides.approvals ?? [],
      attestationText: 'I certify that this monthly reserve report is true and correct.',
    },
    [`GET /api/periods/${PERIOD_ID}`]: {
      id: PERIOD_ID,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      status: 'IN_REVIEW',
    },
    // Deliberately present so a regression is diagnosed rather than merely
    // failing: if the screen calls this again, `requests` records it and the
    // assertions below name it.
    [`GET /api/periods/${PERIOD_ID}/computation`]: LIVE_FIGURES,
  };
}

let dom: InstalledDom | null = null;

async function openCertifyScreen(overrides: Overrides = {}): Promise<InstalledDom> {
  dom = installDom({
    hash: `#/reports/${VERSION_ID}/certify`,
    token: 'test-token',
    routes: routes(overrides),
  });
  await bootConsole();
  return dom;
}

afterEach(() => {
  dom?.restore();
  dom = null;
});

describe('the certification screen renders the document being signed', () => {
  it('shows the stored payload figures, not a live recomputation', async () => {
    const { root } = await openCertifyScreen();
    const screen = root.textContent;

    // 150.00% is what the signed payload says. 105.00% is what the world says
    // now. The signature binds the former.
    expect(screen).toContain('150.00%');
    expect(screen).not.toContain('105.00%');

    expect(screen).toContain('$7,000,000.00');
    expect(screen).not.toContain('$10,000,000.00');
  });

  it('does not ask for the period computation at all', async () => {
    const { requests } = await openCertifyScreen();

    const asked = requests.map((request) => request.path);
    expect(asked).toContain(`/api/reports/${VERSION_ID}`);
    expect(asked).not.toContain(`/api/periods/${PERIOD_ID}/computation`);
  });

  it('blocks signing on a breach recorded in the payload, though none is open now', async () => {
    // The live computation this fixture serves has `breaches: []`. Reading that
    // instead of the payload is exactly what let a version carrying a CRITICAL
    // breach collect four signatures.
    const { root } = await openCertifyScreen();
    const screen = root.textContent;

    expect(screen).toContain('NO SUPPLY OBSERVATION');
    expect(screen).toMatch(/critical breach\(es\) are unresolved/i);

    const signButton = byClass(root, 'primary').find((element) =>
      element.textContent.startsWith('Sign as'),
    );
    expect(signButton, 'the screen should offer a Sign control').toBeDefined();
    expect(signButton!.disabled, 'Sign must be disabled while a payload breach is open').toBe(true);
  });

  it('enables signing once the payload itself is clean', async () => {
    const { root } = await openCertifyScreen({
      payload: { ...SIGNED_PAYLOAD, breaches: [] },
    });

    const acknowledgement = root.textContent;
    expect(acknowledgement).not.toMatch(/critical breach/i);

    // Still the payload's own ratio, not the live one.
    expect(root.textContent).toContain('150.00%');
  });

  it('renders a dash rather than a wrong figure when the payload is malformed', async () => {
    // A payload that is present but not the expected shape must not be coerced
    // into a plausible number. The money formatters return the placeholder, and
    // that is the behaviour a signer needs: a dash sends them to look.
    const { root } = await openCertifyScreen({
      payload: { collateralization: { ratio: 'not-a-number' }, breaches: [] },
    });

    const screen = root.textContent;
    expect(screen).toContain('—');
    expect(screen).not.toContain('%');
  });

  it('survives a payload with no breaches array without hiding the screen', async () => {
    // `breaches` is read off a stored JSON document, so its absence is a real
    // possibility across a schema change. It must not throw — a signing screen
    // that renders an error is a signing screen nobody can use.
    const { root } = await openCertifyScreen({ payload: { collateralization: { ratio: '1.0500' } } });

    expect(root.textContent).toContain('105.00%');
    expect(root.textContent).not.toMatch(/could not|error/i);
  });
});
