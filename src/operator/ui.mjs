/**
 * DOM and formatting helpers for the operator console.
 *
 * Two rules run through this file:
 *
 *  1. Nothing is ever assigned to `innerHTML`. Every node is built with
 *     `createElement` and every string arrives via `createTextNode`, so a
 *     custodian name or a breach message read out of the database cannot become
 *     markup. The page's CSP would block an injected script, but not injected
 *     content, and a fabricated "PASS" badge would be worse than a script.
 *  2. Money is never parsed. Amounts arrive from the API as decimal strings
 *     precisely so they never touch IEEE-754; formatting them here with
 *     `Number()` would reintroduce the rounding the whole system avoids.
 */

/** Build an element. `props` sets attributes, dataset, class and listeners. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.appendChild(document.createTextNode(String(value)));
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Rendered in place of a value that is absent or is not a decimal number. */
const PLACEHOLDER = '—';

/**
 * The shape every money value on this screen must have.
 *
 * Anything else is rendered as `—` rather than passed through. A figure that is
 * quietly wrong is far more dangerous here than one that is visibly missing: an
 * operator who sees a dash goes and looks, while `1.2` in place of `1.2.3` is
 * entirely plausible and gets signed.
 */
const DECIMAL_STRING = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

function isDecimalString(value) {
  return typeof value === 'string' && DECIMAL_STRING.test(value);
}

/** Split a validated decimal string into sign, integer digits and fraction digits. */
function parts(decimal) {
  const negative = decimal.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? decimal.slice(1) : decimal).split('.');
  return { sign: negative ? '-' : '', whole, fraction };
}

/** Strip leading zeros, keeping one digit so '000' becomes '0' rather than ''. */
function trimLeadingZeros(digits) {
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Group the integer part of a decimal string with thousands separators.
 *
 * Pure string manipulation. `Number('10500000.00').toLocaleString()` would be
 * shorter and would silently round anything above 2^53 — which token supply
 * routinely exceeds.
 */
export function groupDigits(decimal) {
  if (!isDecimalString(decimal)) return PLACEHOLDER;

  const { sign, whole, fraction } = parts(decimal);
  const hasFraction = decimal.includes('.');

  let grouped = '';
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ',';
    grouped += whole[i];
  }

  return hasFraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

export function usd(decimal) {
  if (decimal === null || decimal === undefined) return PLACEHOLDER;
  const grouped = groupDigits(decimal);
  // Never '$—': a currency symbol in front of a placeholder reads like a figure.
  return grouped === PLACEHOLDER ? PLACEHOLDER : `$${grouped}`;
}

export function percent(decimal) {
  return isDecimalString(decimal) ? `${decimal}%` : PLACEHOLDER;
}

/**
 * A ratio shown as a percentage: the decimal point shifted two places right.
 *
 * Shifts textually rather than multiplying, for the same reason as above — and
 * shifts correctly at every precision, which the previous implementation did
 * not. It assumed the fractional part was at least two digits long and that
 * stripping leading zeros was safe, so '0.0001' (a 0.01%-collateralized issuer)
 * rendered as '0.1%' — ten times better than the truth, on the screen a CEO
 * reads immediately before attesting to it. Nothing in the console enforces the
 * four decimal places the server happens to send today.
 */
export function ratioToPercent(ratio) {
  if (!isDecimalString(ratio)) return PLACEHOLDER;

  const { sign, whole, fraction } = parts(ratio);

  // Digits of the value with the point removed; `scale` is how many of them sit
  // after the point once it has moved two places right.
  let digits = whole + fraction;
  let scale = fraction.length - 2;
  if (scale < 0) {
    // Fewer than two decimal places: the shift adds trailing zeros.
    digits += '0'.repeat(-scale);
    scale = 0;
  }

  // `cut` is always at least 1: `digits` is never shorter than `fraction`, and
  // `scale` is always shorter still. Leading zeros are trimmed AFTER the split,
  // not before — trimming first is what made '0.0001' render as '0.1%', because
  // it discarded the position the zeros were holding.
  const cut = digits.length - scale;
  const integer = trimLeadingZeros(digits.slice(0, cut));
  const remainder = digits.slice(cut);

  return remainder === ''
    ? `${sign}${integer}%`
    : `${sign}${integer}.${remainder}%`;
}

/**
 * Compare two decimal strings by magnitude, without converting either.
 *
 * Equal-width digit strings compare correctly as strings, so padding both sides
 * to a common width is all the arithmetic that is needed.
 */
function compareDecimal(left, right) {
  const a = parts(left);
  const b = parts(right);
  if (a.sign !== b.sign) return a.sign === '-' ? -1 : 1;

  const wholeWidth = Math.max(a.whole.length, b.whole.length);
  const fractionWidth = Math.max(a.fraction.length, b.fraction.length);
  const x = a.whole.padStart(wholeWidth, '0') + a.fraction.padEnd(fractionWidth, '0');
  const y = b.whole.padStart(wholeWidth, '0') + b.fraction.padEnd(fractionWidth, '0');

  const magnitude = x < y ? -1 : x > y ? 1 : 0;
  return a.sign === '-' ? -magnitude : magnitude;
}

/**
 * Tone for a collateralization ratio: below parity, thin, or comfortable.
 *
 * Compared as a decimal string rather than parsed. `Number.parseInt(ratio.
 * replace('.', ''), 10)` reads correctly only while the API sends exactly four
 * decimal places: at two, '1.05' becomes 105, which compares as catastrophically
 * under-collateralized and paints a fully-backed period red beside a value that
 * reads '105%'. The precision is a server-side formatting choice, so this does
 * not depend on it.
 */
export function collateralTone(ratio) {
  if (!isDecimalString(ratio)) return 'neutral';
  if (compareDecimal(ratio, '1') < 0) return 'bad';
  if (compareDecimal(ratio, '1.0025') < 0) return 'warn';
  return 'good';
}

export function shortHash(hash) {
  if (typeof hash !== 'string' || hash.length < 16) return hash ?? '—';
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/**
 * Full ISO 8601 instant: a date, a time, and an explicit zone.
 *
 * A zone is mandatory. Without one there is no instant to render, only a wall
 * clock reading, and this function's whole output claims to be UTC.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Render an instant in UTC.
 *
 * Everything is shown in UTC because a compliance period boundary must not shift
 * with the operator's timezone.
 *
 * The offset is honoured rather than ignored. Slicing the characters out and
 * appending " UTC" — which is what this did — turned '2026-03-31T23:59:59+02:00'
 * into '23:59:59 UTC', two hours wrong and confidently labelled. It also passed
 * arbitrary text straight through: 'garbage' rendered as 'garbage  UTC'. Every
 * timestamp the API sends today comes from `toISOString()` and so ends in Z, but
 * a function that asserts a zone has to earn the assertion rather than assume the
 * caller. Anything that is not a full instant renders as the placeholder, on the
 * same reasoning as the money formatters: a visibly missing value sends an
 * operator to look, a plausible wrong one gets signed.
 */
export function formatDateTime(iso) {
  if (typeof iso !== 'string' || !ISO_INSTANT.test(iso)) return PLACEHOLDER;

  // Safe to parse: the shape is already validated, and ISO 8601 is the one format
  // `Date` is specified to read identically across engines.
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return PLACEHOLDER;

  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  return `${date} ${time} UTC`;
}

export function statusBadge(status) {
  const tone =
    {
      OPEN: 'neutral',
      IN_REVIEW: 'info',
      CERTIFIED: 'good',
      PUBLISHED: 'good',
      INGESTED: 'good',
      REJECTED: 'bad',
      SUPERSEDED: 'neutral',
      ON_TRACK: 'good',
      WARNING: 'warn',
      ESCALATED: 'bad',
      BREACHED: 'bad',
      CLOSED: 'neutral',
    }[status] ?? 'neutral';
  return el('span', { class: `badge badge-${tone}`, text: status.replace(/_/g, ' ') });
}

export function severityBadge(severity) {
  return el('span', {
    class: `badge badge-${severity === 'CRITICAL' ? 'bad' : 'warn'}`,
    text: severity,
  });
}

/** A table from a header list and an array of cell arrays. */
export function table(headers, rows, options = {}) {
  const numeric = new Set(options.numericColumns ?? []);
  const head = el(
    'tr',
    {},
    headers.map((label, index) =>
      el('th', { class: numeric.has(index) ? 'num' : undefined, text: label }),
    ),
  );

  const body = rows.map((cells) =>
    el(
      'tr',
      {},
      cells.map((cell, index) =>
        el(
          'td',
          { class: numeric.has(index) ? 'num' : undefined },
          typeof cell === 'string' ? document.createTextNode(cell) : cell,
        ),
      ),
    ),
  );

  return el('table', {}, head, ...body);
}

export function emptyState(message) {
  return el('p', { class: 'muted empty', text: message });
}

export function panel(title, ...children) {
  return el('section', { class: 'panel' }, el('h2', { text: title }), ...children);
}
