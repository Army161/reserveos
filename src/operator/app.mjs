/**
 * ReserveOS operator console.
 *
 * Plain ES modules, no framework, no build step — the same choice as the
 * examiner portal, for the same reason: the pages that carry statutory weight
 * should be readable by whoever has to assure them.
 *
 * The design rule that shapes most of this file: the console must never let a
 * signer discover a problem at the moment of signing. Critical breaches disable
 * certification with the reason on screen, the attestation wording is shown
 * verbatim before the button is live, and a missing step-up is stated up front
 * rather than surfacing as a rejected request.
 */
// Relative specifiers, not absolute ones. A module specifier resolves against
// the importing MODULE's URL, so from `/operator/app.mjs` these reach exactly
// `/operator/api.mjs` and `/operator/ui.mjs` — the same files an absolute path
// named. The trap that made absolute paths look necessary is a different one:
// `<script src="./app.mjs">` on a page served at `/operator` resolves against
// the DOCUMENT, giving `/app.mjs`. That is why index.html still uses an absolute
// src, and why it must. Here the absolute form bought nothing and cost the
// ability to test this file at all: Node resolves `/operator/api.mjs` against
// the filesystem root, so no test could ever import this module — which is how
// 763 lines carrying every role gate and the signing panel came to be verified
// only by grepping their source text.
import { api, ApiError, getToken, setToken } from './api.mjs';
import {
  clear,
  collateralTone,
  el,
  emptyState,
  formatDateTime,
  panel,
  percent,
  ratioToPercent,
  severityBadge,
  shortHash,
  statusBadge,
  table,
  usd,
} from './ui.mjs';

const root = document.getElementById('root');
const nav = document.getElementById('nav');
const identity = document.getElementById('identity');

let session = null;

// --- routing ---------------------------------------------------------------

const ROUTES = [
  { pattern: /^\/dashboard$/, view: dashboardView, nav: 'Dashboard' },
  { pattern: /^\/periods$/, view: periodsView, nav: 'Periods' },
  { pattern: /^\/periods\/([0-9a-f-]{36})$/, view: periodView },
  { pattern: /^\/reports\/([0-9a-f-]{36})\/certify$/, view: certifyView },
  { pattern: /^\/ingestion$/, view: ingestionView, nav: 'Ingestion' },
  { pattern: /^\/redemptions$/, view: redemptionsView, nav: 'Redemptions' },
];

function currentPath() {
  const raw = location.hash.replace(/^#/, '');
  return raw === '' ? '/dashboard' : raw;
}

function navigate(path) {
  location.hash = path;
}

async function render() {
  const path = currentPath();

  if (session === null) {
    renderChrome(path);
    clear(root).appendChild(loginView());
    return;
  }

  renderChrome(path);
  const match = ROUTES.map((route) => ({ route, m: route.pattern.exec(path) })).find(
    (candidate) => candidate.m !== null,
  );

  if (match === undefined) {
    clear(root).appendChild(panel('Not found', emptyState(`No screen at ${path}`)));
    return;
  }

  clear(root).appendChild(el('p', { class: 'muted', text: 'Loading…' }));
  try {
    const view = await match.route.view(...match.m.slice(1));
    clear(root).appendChild(view);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // The credential died mid-session — expired, revoked, or the user's access
      // withdrawn. `api.mjs` has already dropped it; drop the session too, so the
      // operator gets the sign-in form instead of an error every screen repeats
      // and none of them can act on.
      session = null;
      renderChrome(path);
      clear(root).append(
        panel(
          'Your session has ended',
          el('p', {
            class: 'bad',
            text: 'Your credential is no longer valid. Sign in again to continue.',
          }),
        ),
        loginView(),
      );
      return;
    }
    clear(root).appendChild(errorPanel(error));
  }
}

function renderChrome(path) {
  clear(nav);
  clear(identity);
  if (session === null) return;

  for (const route of ROUTES.filter((candidate) => candidate.nav !== undefined)) {
    const href = route.pattern.source.replace(/[\\^$]/g, '').replace(/\\\//g, '/');
    const active = route.pattern.test(path);
    nav.appendChild(
      el('a', { href: `#${href}`, class: active ? 'nav-link active' : 'nav-link', text: route.nav }),
    );
  }

  identity.append(
    el('span', { class: 'muted', text: session.issuer.legalName }),
    el('span', { class: 'sep', text: '·' }),
    el('span', { text: session.user.email }),
    el('span', { class: 'roles', text: session.user.roles.join(', ') || 'no roles' }),
    el('button', {
      class: 'link',
      text: 'Sign out',
      onClick: () => {
        setToken(null);
        session = null;
        void render();
      },
    }),
  );
}

function errorPanel(error) {
  const detail =
    error instanceof ApiError
      ? `${error.title}: ${error.message}`
      : (error?.message ?? String(error));
  const correlation = error instanceof ApiError ? error.correlationId : null;

  return panel(
    'Something went wrong',
    el('p', { class: 'bad', text: detail }),
    correlation === null
      ? null
      : el('p', { class: 'muted', text: `Correlation id: ${correlation}` }),
  );
}

// --- login -----------------------------------------------------------------

function loginView() {
  const input = el('input', {
    type: 'password',
    id: 'token',
    placeholder: 'API token',
    autocomplete: 'off',
    'aria-label': 'API token',
  });
  const message = el('p', { class: 'bad' });

  const form = el(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        clear(message);
        setToken(input.value.trim());
        try {
          session = await api.me();
          await render();
        } catch (error) {
          setToken(null);
          session = null;
          message.appendChild(
            document.createTextNode(
              error instanceof ApiError && error.status === 401
                ? 'That token is not valid, or it has expired or been revoked.'
                : `Could not sign in: ${error.message}`,
            ),
          );
        }
      },
    },
    input,
    el('button', { type: 'submit', text: 'Sign in' }),
  );

  return panel(
    'Sign in',
    el('p', {
      class: 'muted',
      text: 'Paste the API token issued to you. It is kept for this browser tab only.',
    }),
    form,
    message,
  );
}

// --- dashboard -------------------------------------------------------------

async function dashboardView() {
  const { periods } = await api.periods();
  const latest = periods[0];

  if (latest === undefined) {
    return panel(
      'No reporting periods yet',
      emptyState('Open the first period from the Periods screen to begin.'),
      el('a', { href: '#/periods', class: 'button', text: 'Go to periods' }),
    );
  }

  const [computation, redemptions] = [await api.computation(latest.id), await api.openRedemptions()];

  const container = el('div', {});
  container.appendChild(
    panel(
      `Current period — ${latest.periodStart} to ${latest.periodEnd}`,
      el(
        'div',
        { class: 'metrics' },
        metric('Collateralization', ratioToPercent(computation.collateralizationRatio), {
          tone: collateralTone(computation.collateralizationRatio),
        }),
        metric('Total reserves', usd(computation.totalReserveValueUsd)),
        metric('Outstanding', usd(computation.totalOutstandingUsd)),
        metric('Status', null, { badge: statusBadge(latest.status) }),
      ),
      el('a', { href: `#/periods/${latest.id}`, class: 'button', text: 'Open period' }),
    ),
  );

  container.appendChild(breachPanel(computation.breaches));
  container.appendChild(compositionPanel(computation));

  const open = redemptions.redemptions ?? [];
  container.appendChild(
    panel(
      `Open redemptions (${open.length})`,
      open.length === 0
        ? emptyState('Nothing outstanding.')
        : table(
            ['Reference', 'Requested', 'Amount', 'SLA deadline', 'State'],
            open
              .slice(0, 10)
              .map((request) => [
                request.externalRef,
                formatDateTime(request.requestedAt),
                usd(request.amountUsd),
                formatDateTime(request.slaDeadline),
                statusBadge(request.slaState),
              ]),
            { numericColumns: [2] },
          ),
    ),
  );

  return container;
}

function metric(label, value, options = {}) {
  return el(
    'div',
    { class: `metric metric-${options.tone ?? 'neutral'}` },
    el('div', { class: 'metric-label', text: label }),
    options.badge ?? el('div', { class: 'metric-value', text: value ?? '—' }),
  );
}

function breachPanel(breaches) {
  if (breaches.length === 0) {
    return panel('Compliance', el('p', { class: 'good', text: 'No breaches detected.' }));
  }

  return panel(
    `Breaches (${breaches.length})`,
    table(
      ['Severity', 'Code', 'Detail'],
      breaches.map((breach) => [
        severityBadge(breach.severity),
        breach.code.replace(/_/g, ' '),
        breach.detail,
      ]),
    ),
  );
}

function compositionPanel(computation) {
  return panel(
    'Reserve composition',
    computation.composition.length === 0
      ? emptyState('No reserve holdings recorded for this period.')
      : table(
          ['Category', 'Market value', 'Share', 'Avg tenor (days)'],
          computation.composition.map((line) => [
            line.category,
            usd(line.marketValueUsd),
            percent(line.percentOfTotal),
            line.weightedAverageTenorDays,
          ]),
          { numericColumns: [1, 2, 3] },
        ),
    el('h3', { text: 'Outstanding by chain' }),
    computation.outstandingByChain.length === 0
      ? emptyState('No supply observations.')
      : table(
          ['Chain', 'Contract', 'Outstanding', 'Block', 'Observed'],
          computation.outstandingByChain.map((chain) => [
            String(chain.chainId),
            shortHash(chain.contractAddress),
            usd(chain.outstandingUsd),
            chain.blockNumber,
            formatDateTime(chain.blockTimestamp),
          ]),
          { numericColumns: [2, 3] },
        ),
  );
}

// --- periods ---------------------------------------------------------------

async function periodsView() {
  const { periods } = await api.periods();
  const canOpen = hasRole('PREPARER', 'ADMIN');

  const start = el('input', { type: 'date', 'aria-label': 'Period start' });
  const end = el('input', { type: 'date', 'aria-label': 'Period end' });
  const message = el('p', { class: 'bad' });

  const form = el(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        clear(message);
        try {
          const created = await api.openPeriod(start.value, end.value);
          navigate(`/periods/${created.id}`);
        } catch (error) {
          message.appendChild(document.createTextNode(error.message));
        }
      },
    },
    start,
    end,
    el('button', { type: 'submit', text: 'Open period' }),
  );

  return el(
    'div',
    {},
    panel(
      'Reporting periods',
      periods.length === 0
        ? emptyState('No periods yet.')
        : table(
            ['Period', 'Status', 'Opened', ''],
            periods.map((period) => [
              `${period.periodStart} → ${period.periodEnd}`,
              statusBadge(period.status),
              formatDateTime(period.createdAt),
              el('a', { href: `#/periods/${period.id}`, class: 'link', text: 'Open' }),
            ]),
          ),
    ),
    canOpen
      ? panel('Open a new period', form, message)
      : panel(
          'Open a new period',
          emptyState('Opening a period requires the PREPARER role.'),
        ),
  );
}

async function periodView(periodId) {
  const [period, computation] = [await api.period(periodId), await api.computation(periodId)];
  const critical = computation.breaches.filter((breach) => breach.severity === 'CRITICAL');
  const latestVersion = period.versions[period.versions.length - 1];

  const message = el('p', {});

  const container = el(
    'div',
    {},
    panel(
      `Period ${period.periodStart} → ${period.periodEnd}`,
      el(
        'div',
        { class: 'metrics' },
        metric('Collateralization', ratioToPercent(computation.collateralizationRatio), {
          tone: collateralTone(computation.collateralizationRatio),
        }),
        metric('Total reserves', usd(computation.totalReserveValueUsd)),
        metric('Outstanding', usd(computation.totalOutstandingUsd)),
        metric('Status', null, { badge: statusBadge(period.status) }),
      ),
    ),
  );

  container.appendChild(breachPanel(computation.breaches));
  container.appendChild(compositionPanel(computation));

  const actions = el('div', { class: 'actions' });

  if (hasRole('PREPARER', 'ADMIN') && period.status !== 'PUBLISHED') {
    actions.appendChild(
      el('button', {
        text: period.versions.length === 0 ? 'Generate report' : 'Regenerate report',
        onClick: async () => {
          clear(message);
          try {
            const result = await api.generateReport(periodId);
            message.className = 'good';
            message.appendChild(
              document.createTextNode(
                `Version ${result.version} generated — ${shortHash(result.payloadHash)}`,
              ),
            );
            await render();
          } catch (error) {
            message.className = 'bad';
            message.appendChild(document.createTextNode(error.message));
          }
        },
      }),
    );
  }

  if (period.status === 'CERTIFIED' && hasRole('COMPLIANCE', 'CFO', 'CEO', 'ADMIN')) {
    actions.appendChild(
      el('button', {
        class: 'primary',
        text: 'Publish',
        onClick: async () => {
          clear(message);
          try {
            await api.publish(periodId);
            await render();
          } catch (error) {
            message.className = 'bad';
            message.appendChild(document.createTextNode(error.message));
          }
        },
      }),
    );
  }

  if (latestVersion !== undefined && period.status !== 'PUBLISHED') {
    actions.appendChild(
      el('a', {
        href: `#/reports/${latestVersion.id}/certify`,
        class: 'button',
        text: 'Certification',
      }),
    );
  }

  container.appendChild(
    panel(
      'Report versions',
      period.versions.length === 0
        ? emptyState('No report generated yet.')
        : table(
            ['Version', 'Payload hash', 'Generated', ''],
            period.versions.map((version) => [
              String(version.version),
              el('code', { text: shortHash(version.payloadHash) }),
              formatDateTime(version.generatedAt),
              el('a', {
                href: `#/reports/${version.id}/certify`,
                class: 'link',
                text: 'View',
              }),
            ]),
            { numericColumns: [0] },
          ),
      critical.length > 0
        ? el('p', {
            class: 'bad',
            text: `${critical.length} critical breach(es) must be resolved before this period can be certified.`,
          })
        : null,
      actions,
      message,
    ),
  );

  return container;
}

// --- certification ---------------------------------------------------------

/**
 * Everything on this screen comes out of the report version being signed.
 *
 * Not from `GET /api/periods/:id/computation`, which is what this screen used to
 * read. That endpoint recomputes from the facts on hand right now, and a signer
 * is not attesting to those — they are attesting to `report.payload`, the
 * snapshot taken when the version was generated, whose hash their signature
 * binds. The two diverge as soon as a corrected custodian statement or a late
 * supply observation arrives, which is the ordinary month-end flow, and this
 * screen printed the live collateralization ratio directly beneath the payload
 * hash of the frozen document. The server now refuses to certify a version whose
 * facts have moved, so a divergence surfaces as a rejected request rather than a
 * wrong number; showing the payload's own figures is what makes the screen agree
 * with that refusal instead of arguing with it.
 */
async function certifyView(versionId) {
  const report = await api.report(versionId);
  const chain = await api.approvals(versionId);
  const period = await api.period(report.periodId);

  const signed = report.payload ?? {};
  const breaches = Array.isArray(signed.breaches) ? signed.breaches : [];
  const critical = breaches.filter((breach) => breach.severity === 'CRITICAL');
  const nextRole = chain.nextRole;
  const mine = nextRole !== null && session.user.roles.includes(nextRole);

  const container = el(
    'div',
    {},
    panel(
      `Certification — version ${report.version}`,
      el(
        'dl',
        { class: 'facts' },
        el('dt', { text: 'Period' }),
        el('dd', { text: `${period.periodStart} → ${period.periodEnd}` }),
        el('dt', { text: 'Payload hash' }),
        el('dd', {}, el('code', { text: report.payloadHash })),
        el('dt', { text: 'Generated' }),
        el('dd', { text: formatDateTime(report.generatedAt) }),
      ),
      el(
        'div',
        { class: 'metrics' },
        metric('Collateralization', ratioToPercent(signed.collateralization?.ratio), {
          tone: collateralTone(signed.collateralization?.ratio),
        }),
        metric('Total reserves', usd(signed.reserves?.totalMarketValueUsd)),
        metric('Outstanding', usd(signed.outstanding?.totalUsd)),
      ),
    ),
    panel(
      'Approval chain',
      table(
        ['Stage', 'Signed by', 'Decision', 'When'],
        ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'].map((role) => {
          const signed = chain.approvals.find((approval) => approval.role === role);
          return [
            role,
            signed?.actorEmail ?? (role === nextRole ? el('em', { text: 'next' }) : '—'),
            signed === undefined ? '—' : statusBadge(signed.decision),
            signed === undefined ? '—' : formatDateTime(signed.signedAt),
          ];
        }),
      ),
    ),
  );

  if (critical.length > 0) container.appendChild(breachPanel(breaches));

  container.appendChild(signingPanel({ versionId, nextRole, mine, critical, chain }));
  return container;
}

function signingPanel({ versionId, nextRole, mine, critical, chain }) {
  if (nextRole === null) {
    return panel(
      'Signing',
      el('p', {
        class: 'good',
        text:
          chain.approvals.some((approval) => approval.decision === 'REJECTED')
            ? 'This version was rejected. Resolve the issue and generate a new version.'
            : 'This version is fully certified.',
      }),
    );
  }

  if (!mine) {
    return panel(
      'Signing',
      el('p', {
        class: 'muted',
        text: `Waiting on ${nextRole}. You do not hold that role, so there is nothing for you to sign here.`,
      }),
    );
  }

  // The wording is the signer's statutory attestation. If the server did not
  // supply it, refuse to sign rather than showing a placeholder — nobody should
  // certify text they were not shown.
  const wording = chain.attestationText ?? null;
  if (wording === null) {
    return panel(
      'Signing',
      el('p', {
        class: 'bad',
        text:
          'The attestation wording for this stage could not be loaded. Signing is disabled: ' +
          'you must not certify a statement you have not read.',
      }),
    );
  }

  const executive = nextRole === 'CFO' || nextRole === 'CEO';
  const acknowledgement = el('input', { type: 'checkbox', id: 'ack' });
  const message = el('p', {});
  const approve = el('button', { class: 'primary', text: `Sign as ${nextRole}`, disabled: true });
  const reject = el('button', { class: 'danger', text: 'Reject' });

  const blockedReason =
    critical.length > 0
      ? `${critical.length} critical breach(es) are unresolved. Certification is blocked until they are fixed and the report is regenerated.`
      : executive && !session.user.stepUpVerified
        ? 'This signature requires step-up authentication. Verify below, then sign.'
        : null;

  function refresh() {
    approve.disabled = !acknowledgement.checked || blockedReason !== null;
  }
  acknowledgement.addEventListener('change', refresh);

  approve.addEventListener('click', async () => {
    clear(message);
    try {
      const result = await api.approve(versionId, nextRole, 'APPROVED');
      message.className = 'good';
      message.appendChild(
        document.createTextNode(
          result.certified
            ? 'Signed. The period is now fully certified and can be published.'
            : `Signed as ${result.role}.`,
        ),
      );
      await render();
    } catch (error) {
      message.className = 'bad';
      message.appendChild(document.createTextNode(error.message));
    }
  });

  reject.addEventListener('click', async () => {
    clear(message);
    try {
      await api.approve(versionId, nextRole, 'REJECTED');
      await render();
    } catch (error) {
      message.className = 'bad';
      message.appendChild(document.createTextNode(error.message));
    }
  });

  const stepUp = el('button', {
    text: 'Verify identity',
    onClick: async () => {
      clear(message);
      try {
        await api.stepUp();
        session = await api.me();
        await render();
      } catch (error) {
        message.className = 'bad';
        message.appendChild(document.createTextNode(error.message));
      }
    },
  });

  refresh();

  return panel(
    'Signing',
    el('p', { class: 'muted', text: `You are signing as ${nextRole}. Read the statement below.` }),
    el('blockquote', { class: 'attestation', text: wording }),
    blockedReason === null ? null : el('p', { class: 'bad', text: blockedReason }),
    executive && !session.user.stepUpVerified ? stepUp : null,
    el(
      'label',
      { class: 'ack' },
      acknowledgement,
      ' I have read the statement above and I am making it personally.',
    ),
    el('div', { class: 'actions' }, approve, reject),
    message,
  );
}

// --- ingestion and redemptions ---------------------------------------------

async function ingestionView() {
  const [{ documents }, { custodians }] = [await api.documents(), await api.custodians()];
  const rejected = documents.filter((document) => document.status === 'REJECTED');

  return el(
    'div',
    {},
    panel(
      'Custodian feeds',
      custodians.length === 0
        ? emptyState('No custodians configured.')
        : table(
            ['Custodian', 'Jurisdiction', 'Connector', 'Active'],
            custodians.map((custodian) => [
              custodian.name,
              custodian.jurisdiction,
              custodian.connectorType,
              custodian.active ? 'yes' : 'no',
            ]),
          ),
    ),
    rejected.length === 0
      ? null
      : panel(
          `Rejected statements (${rejected.length})`,
          el('p', {
            class: 'muted',
            text: 'These files were quarantined and contributed nothing to the figures.',
          }),
          table(
            ['File', 'Ingested', 'Reason'],
            rejected.map((document) => [
              document.filename,
              formatDateTime(document.ingestedAt),
              el('span', { class: 'bad', text: document.rejectionReason ?? '—' }),
            ]),
          ),
        ),
    panel(
      'Ingested statements',
      documents.length === 0
        ? emptyState('Nothing ingested yet.')
        : table(
            ['File', 'Statement date', 'Rows', 'Status', 'Content hash'],
            documents.map((document) => [
              document.filename,
              document.statementAsOf?.slice(0, 10) ?? '—',
              document.rowCount === null ? '—' : String(document.rowCount),
              statusBadge(document.status),
              el('code', { text: shortHash(document.contentHash) }),
            ]),
            { numericColumns: [2] },
          ),
    ),
  );
}

async function redemptionsView() {
  const { redemptions } = await api.openRedemptions();
  return panel(
    `Open redemptions (${redemptions.length})`,
    redemptions.length === 0
      ? emptyState('Nothing outstanding.')
      : table(
          ['Reference', 'Requested', 'Amount', 'SLA deadline', 'State'],
          redemptions.map((request) => [
            request.externalRef,
            formatDateTime(request.requestedAt),
            usd(request.amountUsd),
            formatDateTime(request.slaDeadline),
            statusBadge(request.slaState),
          ]),
          { numericColumns: [2] },
        ),
  );
}

// --- boot ------------------------------------------------------------------

function hasRole(...roles) {
  return roles.some((role) => session?.user.roles.includes(role));
}

window.addEventListener('hashchange', () => void render());

if (getToken() !== null) {
  try {
    session = await api.me();
  } catch {
    setToken(null);
    session = null;
  }
}

await render();
