/**
 * Examiner portal page script.
 *
 * A separate file rather than an inline block: the page ships a strict
 * `script-src 'self'` policy, which forbids inline script. Keeping it external
 * lets the policy stay strict AND lets an examiner read every line the browser
 * executed, which is the point of the page.
 */
import { verifyResponse } from '/portal/verify-client.mjs';

const form = document.getElementById('form');
const input = document.getElementById('hash');
const submit = document.getElementById('submit');
const output = document.getElementById('output');
const errorBox = document.getElementById('error');

const text = (value) => document.createTextNode(String(value));

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.appendChild(text(content));
  return node;
}

function renderChecks(result) {
  const container = document.getElementById('checks');
  container.replaceChildren();

  for (const check of result.checks) {
    const box = element('div', 'check');
    const head = element('div', 'check-head');
    head.appendChild(element('span', `mark ${check.passed ? 'pass' : 'fail'}`, check.passed ? 'PASS' : 'FAIL'));
    head.appendChild(element('span', null, check.label));
    box.appendChild(head);
    box.appendChild(element('p', null, check.explanation));

    if (!check.passed) {
      const hashes = element('div', 'hashes');
      const expected = element('div');
      expected.appendChild(element('span', 'muted', 'served: '));
      expected.appendChild(element('code', null, check.expected ?? '(none)'));
      const actual = element('div');
      actual.appendChild(element('span', 'muted', 'computed here: '));
      actual.appendChild(element('code', null, check.actual ?? '(none)'));
      hashes.append(expected, actual);
      box.appendChild(hashes);
    }
    container.appendChild(box);
  }
}

function renderSummary(data) {
  const container = document.getElementById('summary');
  container.replaceChildren();

  const disclosure = data.disclosure ?? {};
  const reserves = disclosure.reserves ?? {};
  const outstanding = disclosure.outstanding ?? {};
  const collateral = disclosure.collateralization ?? {};
  // Read from the disclosure, never from the surrounding response. The dates in
  // `data.period` are outside `disclosureHash`, so printing them would put an
  // unverified heading directly above a column of verified figures.
  const period = disclosure.period ?? {};

  const meta = element('table');
  const rows = [
    ['Issuer', disclosure.issuer?.legalName ?? '—'],
    ['Regulator', disclosure.issuer?.regulator ?? '—'],
    ['Period', `${period.start ?? '—'} to ${period.end ?? '—'}`],
    ['Valued as of', period.asOf ?? '—'],
    ['Total reserves (USD)', reserves.totalMarketValueUsd ?? '—'],
    ['Outstanding (USD)', outstanding.totalUsd ?? '—'],
    ['Collateralization', collateral.ratioPercent ? `${collateral.ratioPercent}%` : '—'],
  ];
  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(element('th', null, label));
    tr.appendChild(element('td', 'num', value));
    meta.appendChild(tr);
  }
  container.appendChild(meta);

  const composition = reserves.composition ?? [];
  if (composition.length > 0) {
    container.appendChild(element('h2', null, 'Reserve composition'));
    const table = element('table');
    const header = document.createElement('tr');
    for (const label of ['Category', 'Market value (USD)', 'Share', 'Avg tenor (days)']) {
      header.appendChild(element('th', null, label));
    }
    table.appendChild(header);
    for (const line of composition) {
      const tr = document.createElement('tr');
      tr.appendChild(element('td', null, line.category));
      tr.appendChild(element('td', 'num', line.marketValueUsd));
      tr.appendChild(element('td', 'num', `${line.percentOfTotal}%`));
      tr.appendChild(element('td', 'num', line.weightedAverageTenorDays));
      table.appendChild(tr);
    }
    container.appendChild(table);
  }
}

function renderIndependentStep(step) {
  const box = document.getElementById('independent');
  box.replaceChildren();
  if (step === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.appendChild(element('strong', null, 'One step this page cannot do for you. '));
  box.appendChild(text(step.instruction));
  const detail = element('div', 'hashes');
  const tx = element('div');
  tx.appendChild(element('span', 'muted', 'transaction: '));
  tx.appendChild(element('code', null, step.transactionHash));
  detail.appendChild(tx);
  const root = element('div');
  root.appendChild(element('span', 'muted', 'commitment to look for: '));
  root.appendChild(element('code', null, step.commitment));
  detail.appendChild(root);
  if (step.blockNumber) {
    const block = element('div');
    block.appendChild(element('span', 'muted', 'block: '));
    block.appendChild(element('code', null, step.blockNumber));
    detail.appendChild(block);
  }
  if (step.anchoredAt) {
    const at = element('div');
    at.appendChild(element('span', 'muted', 'anchored at: '));
    at.appendChild(element('code', null, step.anchoredAt));
    detail.appendChild(at);
  }
  box.appendChild(detail);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  output.hidden = true;
  submit.disabled = true;

  const hash = input.value.trim().toLowerCase();
  try {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('That is not a 64-character hex hash.');
    }

    const response = await fetch(`/verify/${hash}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem.detail ?? `No published report matches that hash.`);
    }

    const data = await response.json();
    // The hash is passed in, not read back out of the response. It is the only
    // input this page did not receive from the server, and without it every
    // check below would just be the server agreeing with itself.
    const result = await verifyResponse(data, hash);

    const verdict = document.getElementById('verdict');
    verdict.className = `verdict ${result.allPassed ? 'pass' : 'fail'}`;
    // Deliberately not "these figures match the ledger": this page has not read
    // the ledger and cannot. Claiming otherwise would be the exact dishonesty
    // the whole design exists to avoid.
    verdict.textContent = result.allPassed
      ? 'Every check this page can make passed. One step is left, and only you can do it: look up the transaction below on the ledger.'
      : 'Verification failed. Do not rely on these figures.';

    renderChecks(result);
    renderIndependentStep(result.independentStep);
    renderSummary(data);
    document.getElementById('canonical').textContent = data.canonicalJson;

    output.hidden = false;
  } catch (failure) {
    errorBox.textContent = failure.message;
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// Deep link: /portal/#<hash> verifies immediately.
const initial = location.hash.replace(/^#/, '').trim();
if (/^[0-9a-f]{64}$/i.test(initial)) {
  input.value = initial.toLowerCase();
  form.requestSubmit();
}
