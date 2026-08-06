import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { databaseAvailable, resetDatabase, seedTenant, testPool } from '../db/harness.js';
import { bearer, createTestServer, seedBackedPeriod, seedUser } from './../api/helpers.js';
import type { TestServer, TestUser } from './../api/helpers.js';
import { formatMinor, formatRatio } from '../../src/domain/money.js';
import {
  clear,
  collateralTone,
  el,
  groupDigits,
  percent,
  ratioToPercent,
  statusBadge,
  table,
  usd,
} from '../../src/operator/ui.mjs';

/**
 * Adversarial review of the operator console.
 *
 * The console is the screen a CEO reads immediately before making an attestation
 * that carries personal criminal liability. Three properties have to hold there
 * and nowhere else can enforce them:
 *
 *  1. Nothing read out of the database can become markup. A fabricated "PASS"
 *     badge on a compliance screen is worse than an injected script, because the
 *     CSP stops the script and nothing stops the badge.
 *  2. No money value is ever parsed. Amounts arrive as decimal strings precisely
 *     so they never touch IEEE-754, and the last place that guarantee can be
 *     thrown away is on the way to the screen.
 *  3. Hiding a button is not a control. Every action the console gates by role
 *     must be refused by the server for a caller who calls the endpoint directly.
 *
 * There is no DOM in this environment and jsdom is deliberately not installed, so
 * the rendering helpers run against a hand-written double below that models the
 * one browser behaviour these tests depend on: `appendChild` accepts nodes and
 * throws on anything else. It never parses markup, which is why the absence of
 * markup sinks is proved separately, by reading the bytes the server ships.
 */

const OPERATOR_DIR = join(process.cwd(), 'src', 'operator');
const SOURCE_FILES = ['app.mjs', 'api.mjs', 'ui.mjs', 'index.html'] as const;

const SOURCES: Record<string, string> = Object.fromEntries(
  SOURCE_FILES.map((name) => [name, readFileSync(join(OPERATOR_DIR, name), 'utf8')]),
);

/**
 * Drop comment lines before scanning for forbidden identifiers.
 *
 * Line-oriented on purpose: a general comment stripper has to understand regex
 * literals, and `app.mjs` contains `/\\\//g`, which a naive one truncates. Every
 * comment in these files is either a whole `//` line or a JSDoc continuation
 * beginning with `*`, so dropping those lines is exact and cannot silently eat
 * code that a sink might be hiding on.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*/')
      );
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// A minimal DOM double
// ---------------------------------------------------------------------------

class FakeNode {
  readonly childNodes: FakeNode[] = [];

  appendChild(child: unknown): FakeNode {
    // The browser's contract, reproduced exactly: a non-Node is a TypeError, not
    // a stringified child. Softening this here would invent behaviour the real
    // page does not have.
    if (!(child instanceof FakeNode)) {
      throw new TypeError(
        "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
      );
    }
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...nodes: unknown[]): void {
    this.childNodes.length = 0;
    for (const node of nodes) this.appendChild(node);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
}

class FakeText extends FakeNode {
  constructor(readonly data: string) {
    super();
  }

  override get textContent(): string {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listenerTypes: string[] = [];
  className = '';

  constructor(readonly tagName: string) {
    super();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string): void {
    this.listenerTypes.push(type);
  }
}

const globalWithDom = globalThis as unknown as {
  document?: unknown;
  sessionStorage?: unknown;
  fetch?: unknown;
};

beforeAll(() => {
  globalWithDom.document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
});

afterAll(() => {
  delete globalWithDom.document;
});

function walk(node: FakeNode): FakeNode[] {
  return node.childNodes.flatMap((child) => [child, ...walk(child)]);
}

function textNodes(node: FakeNode): FakeText[] {
  return walk(node).filter((child): child is FakeText => child instanceof FakeText);
}

function elements(node: FakeNode): FakeElement[] {
  return walk(node).filter((child): child is FakeElement => child instanceof FakeElement);
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

describe('markup sinks', () => {
  /**
   * A guard against re-introduction, not a proof of the current state.
   *
   * `ui.mjs` claims in a comment that nothing is ever assigned to `innerHTML`.
   * A comment does not survive an edit; this does.
   */
  const SINKS: readonly (readonly [string, RegExp])[] = [
    ['innerHTML assignment', /\binnerHTML\b/],
    ['outerHTML assignment', /\bouterHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
    ['document.write', /\bdocument\s*\.\s*write(?:ln)?\s*\(/],
    ['new Function', /\bnew\s+Function\s*\(/],
    ['eval', /(?<![\w.])eval\s*\(/],
    ['createContextualFragment', /\bcreateContextualFragment\b/],
    ['srcdoc', /\bsrcdoc\b/],
    ['setHTMLUnsafe', /\bsetHTMLUnsafe\b/],
  ];

  for (const name of SOURCE_FILES) {
    for (const [label, pattern] of SINKS) {
      it(`${name} contains no ${label}`, () => {
        expect(withoutComments(SOURCES[name] ?? '')).not.toMatch(pattern);
      });
    }
  }

  it('builds every node through createElement/createTextNode only', () => {
    // The whole rendering surface reaches the page through these two calls.
    const code = withoutComments(SOURCES['ui.mjs'] ?? '');
    expect(code).toMatch(/document\.createElement\(/);
    expect(code).toMatch(/document\.createTextNode\(/);
    // `el` is the only thing in the console that touches `document` directly.
    expect(withoutComments(SOURCES['app.mjs'] ?? '')).not.toMatch(/document\.createElement/);
  });
});

describe('hostile database strings reach the page as text', () => {
  const HOSTILE = '<span class="badge badge-good">PASS</span><img src=x onerror=alert(1)>';

  it('renders a custodian name as a single text node', () => {
    const rendered = table(['Custodian'], [[HOSTILE]]);
    const texts = textNodes(rendered).map((node) => node.data);

    expect(texts).toContain(HOSTILE);
    // No element was created from the string: the only elements are the ones the
    // table itself builds.
    expect(elements(rendered).map((node) => node.tagName)).toEqual(['tr', 'th', 'tr', 'td']);
  });

  /**
   * The other way a string reaches the page.
   *
   * `el` takes children positionally as well as through the `text` prop — the
   * signing panel passes the acknowledgement wording that way — and a string
   * arriving there has to become a text node just the same.
   */
  it('renders a positional string child as text', () => {
    const node = el('label', { class: 'ack' }, el('input', { type: 'checkbox' }), HOSTILE);
    expect(textNodes(node).map((child) => child.data)).toEqual([HOSTILE]);
    expect(elements(node).map((child) => child.tagName)).toEqual(['input']);
  });

  it('renders a breach detail and a server error message as text', () => {
    for (const value of [HOSTILE, 'Custodian "<b>BNY</b>" failed reconciliation']) {
      const node = el('p', { class: 'bad', text: value });
      expect(textNodes(node).map((child) => child.data)).toEqual([value]);
      expect(elements(node)).toEqual([]);
    }
  });

  it('renders a status that is not in the badge map as text, not markup', () => {
    const badge = statusBadge('<b>CERTIFIED</b>');
    expect(textNodes(badge).map((node) => node.data)).toEqual(['<b>CERTIFIED</b>']);
    expect(badge.className).toBe('badge badge-neutral');
  });

  it('attaches handlers with addEventListener rather than an inline attribute', () => {
    const node = el('button', { onClick: () => undefined, text: 'Sign' });
    expect(node.listenerTypes).toEqual(['click']);
    expect([...node.attributes.keys()]).not.toContain('onclick');
  });

  it('clears a container without going through markup', () => {
    const host = el('div', {}, el('span', { text: 'old' }));
    expect(clear(host).childNodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Money precision
// ---------------------------------------------------------------------------

describe('groupDigits', () => {
  it('keeps every digit of a value far beyond 2^53', () => {
    const raw = (10_000_000_000n * 10n ** 18n).toString();
    expect(groupDigits(raw).replace(/,/g, '')).toBe(raw);
    // Proof no float was involved: this value is not representable as a Number.
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('preserves an arbitrary number of decimal places verbatim', () => {
    expect(groupDigits('1234567.123456789012345678')).toBe('1,234,567.123456789012345678');
  });

  it('groups a value with no fractional part', () => {
    expect(groupDigits('1000000')).toBe('1,000,000');
    expect(groupDigits('999')).toBe('999');
  });

  it('handles negatives and leading zeros without dropping a digit', () => {
    expect(groupDigits('-1234567.89')).toBe('-1,234,567.89');
    expect(groupDigits('0001234.5')).toBe('0,001,234.5');
    expect(groupDigits('0.05')).toBe('0.05');
  });

  it('round-trips what the domain layer formats, at both extremes', () => {
    expect(usd(formatMinor(5n))).toBe('$0.05');
    expect(usd(formatMinor(10n ** 30n))).toBe('$10,000,000,000,000,000,000,000,000,000.00');
  });

  /**
   * Malformed input must be visibly absent, not quietly altered.
   *
   * `'1.2.3'` used to render as `1.2`: the second separator and everything after
   * it were dropped, so a corrupt figure appeared on screen as a smaller, entirely
   * plausible one. On a reserve report the failure mode of a wrong number is much
   * worse than the failure mode of a missing one.
   */
  it('refuses to render anything that is not a decimal number', () => {
    for (const bad of ['1.2.3', 'abc', '-', '1,000', '1e21', ' 12', '12 ', '--1']) {
      expect(groupDigits(bad)).toBe('—');
    }
    expect(groupDigits('')).toBe('—');
    expect(groupDigits(undefined as unknown as string)).toBe('—');
    expect(groupDigits(null as unknown as string)).toBe('—');
  });

  it('never renders a currency symbol in front of a placeholder', () => {
    expect(usd(null)).toBe('—');
    expect(usd('')).toBe('—');
    expect(usd('1.2.3')).toBe('—');
  });

  it('rejects a malformed percentage rather than printing it', () => {
    expect(percent('80.95')).toBe('80.95%');
    expect(percent(null)).toBe('—');
    expect(percent('80.9.5')).toBe('—');
  });
});

describe('ratioToPercent', () => {
  /**
   * The oracle is the server's own exact-decimal formatter.
   *
   * A ratio of `bps/10000` is, exactly, `bps/100` percent. `formatRatio` computes
   * both with bigint division, so the expectation is derived independently of the
   * client-side string shifting it is checking.
   */
  const bpsCases = [
    0, 1, 5, 9, 10, 12, 99, 100, 999, 1000, 5000, 9987, 9999, 10_000, 10_001, 10_025, 12_345,
    99_999, 1_000_000,
  ];

  it('agrees with the server formatter for every ratio the API can emit', () => {
    for (const bps of bpsCases) {
      const wire = formatRatio(BigInt(bps), 10_000n, 4);
      const expected = `${formatRatio(BigInt(bps), 100n, 2)}%`;
      expect(`${bps}bps -> ${ratioToPercent(wire)}`).toBe(`${bps}bps -> ${expected}`);
    }
  });

  it('is exact for the smallest ratios the dashboard can be asked to show', () => {
    // A near-total reserve loss, or an ingestion failure that loaded almost
    // nothing against full observed supply. These used to read ten times better
    // than the truth: '0.0001' rendered as '0.1%'.
    expect(ratioToPercent('0.0001')).toBe('0.01%');
    expect(ratioToPercent('0.0005')).toBe('0.05%');
    expect(ratioToPercent('0.0009')).toBe('0.09%');
    expect(ratioToPercent('0.0000')).toBe('0.00%');
    expect(ratioToPercent('0.0010')).toBe('0.10%');
  });

  it('is exact at other precisions, so a server formatting change cannot skew it', () => {
    expect(ratioToPercent('1')).toBe('100%');
    expect(ratioToPercent('1.5')).toBe('150%');
    expect(ratioToPercent('105')).toBe('10500%');
    expect(ratioToPercent('1.05')).toBe('105%');
    expect(ratioToPercent('1.050')).toBe('105.0%');
    expect(ratioToPercent('0.00001')).toBe('0.001%');
  });

  it('keeps every digit of a ratio beyond 2^53', () => {
    const wire = formatRatio(10n ** 24n, 10_000n, 4);
    expect(ratioToPercent(wire)).toBe(`${formatRatio(10n ** 24n, 100n, 2)}%`);
  });

  it('carries a sign through', () => {
    expect(ratioToPercent('-1.0500')).toBe('-105.00%');
    expect(ratioToPercent('-0.0001')).toBe('-0.01%');
  });

  it('refuses malformed input rather than printing it with a percent sign', () => {
    for (const bad of ['abc', '1.2.3', '', '-', '1e-4']) {
      expect(ratioToPercent(bad)).toBe('—');
    }
    expect(ratioToPercent(null as unknown as string)).toBe('—');
  });
});

describe('collateralTone', () => {
  it('classifies the boundaries the dashboard colours', () => {
    expect(collateralTone('0.9999')).toBe('bad');
    expect(collateralTone('1.0000')).toBe('warn');
    expect(collateralTone('1.0024')).toBe('warn');
    expect(collateralTone('1.0025')).toBe('good');
    expect(collateralTone('1.0500')).toBe('good');
  });

  it('agrees with the digit-parsing implementation it replaced, on 4dp input', () => {
    // The old helper did `Number.parseInt(ratio.replace('.', ''), 10)`. Behaviour
    // is preserved for every value the API actually sends.
    const legacy = (ratio: string): string => {
      const digits = Number.parseInt(ratio.replace('.', ''), 10);
      if (!Number.isFinite(digits)) return 'neutral';
      if (digits < 10_000) return 'bad';
      if (digits < 10_025) return 'warn';
      return 'good';
    };
    for (let bps = 0; bps <= 12_000; bps += 7) {
      const wire = formatRatio(BigInt(bps), 10_000n, 4);
      expect(`${wire}:${collateralTone(wire)}`).toBe(`${wire}:${legacy(wire)}`);
    }
  });

  /**
   * The reason the parse had to go.
   *
   * `Number.parseInt('1.05'.replace('.', ''))` is 105, which compares as
   * catastrophically under-collateralized and paints a fully-backed period red
   * while the value beside it reads '105%'. Four decimal places is a server-side
   * formatting choice that nothing in the console enforces.
   */
  it('is not fooled by a ratio carrying a different number of decimal places', () => {
    expect(collateralTone('1.05')).toBe('good');
    expect(collateralTone('1.0')).toBe('warn');
    expect(collateralTone('1')).toBe('warn');
    expect(collateralTone('0.99')).toBe('bad');
    expect(collateralTone('2')).toBe('good');
  });

  it('falls back to neutral rather than guessing', () => {
    expect(collateralTone(null as unknown as string)).toBe('neutral');
    expect(collateralTone('abc')).toBe('neutral');
    expect(collateralTone('')).toBe('neutral');
  });
});

describe('no money value is ever parsed', () => {
  const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
    ['Number(', /\bNumber\s*\(/],
    ['Number.parseInt / Number.parseFloat', /\bNumber\s*\.\s*parse(?:Int|Float)\b/],
    ['parseInt(', /(?<![\w.])parseInt\s*\(/],
    ['parseFloat(', /(?<![\w.])parseFloat\s*\(/],
    ['toLocaleString', /\btoLocaleString\b/],
    ['toFixed', /\btoFixed\b/],
    ['unary plus coercion', /[=(,]\s*\+[A-Za-z_$]/],
  ];

  for (const name of ['app.mjs', 'api.mjs', 'ui.mjs'] as const) {
    for (const [label, pattern] of FORBIDDEN) {
      it(`${name} does not use ${label}`, () => {
        expect(withoutComments(SOURCES[name] ?? '')).not.toMatch(pattern);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

interface OperatorApiModule {
  readonly ApiError: new (status: number, problem: unknown) => Error & {
    status: number;
    title: string;
    correlationId: string | null;
  };
  readonly getToken: () => string | null;
  readonly setToken: (token: string | null) => void;
  readonly api: Record<string, (...args: string[]) => Promise<unknown>>;
}

// Imported by absolute URL: `api.mjs` ships to the browser as untyped JavaScript
// and has no declaration file, so a static import would not typecheck.
const apiModule = (await import(
  /* @vite-ignore */ pathToFileURL(join(OPERATOR_DIR, 'api.mjs')).href
)) as unknown as OperatorApiModule;

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

const TOKEN = 'rsos_TESTTOKENvalue0000000000000000000000000';

let captured: CapturedRequest[] = [];
let respondWith: () => { status: number; body: string };

function installFetch(): void {
  captured = [];
  respondWith = () => ({ status: 200, body: '{}' });
  globalWithDom.fetch = (url: string, init: RequestInit) => {
    captured.push({ url, init });
    const { status, body } = respondWith();
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(body),
    });
  };
}

function installSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  globalWithDom.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

describe('token handling', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installSessionStorage();
    installFetch();
    apiModule.setToken(TOKEN);
  });

  afterEach(() => {
    delete globalWithDom.fetch;
    delete globalWithDom.sessionStorage;
  });

  it('keeps the credential in sessionStorage only', () => {
    expect(apiModule.getToken()).toBe(TOKEN);
    expect([...store.values()]).toEqual([TOKEN]);
  });

  it('sends the token in a header and never in a URL, query string or fragment', async () => {
    for (const [name, call] of Object.entries(apiModule.api)) {
      await call('11111111-1111-1111-1111-111111111111', 'CFO', 'APPROVED');
      const request = captured.at(-1);
      expect(request, name).toBeDefined();

      const url = request?.url ?? '';
      const body = typeof request?.init.body === 'string' ? request.init.body : '';
      expect(`${name}:${url}`).not.toContain(TOKEN);
      expect(`${name}:${body}`).not.toContain(TOKEN);
      expect(`${name}:${url}`).not.toContain('?');
      expect(`${name}:${url}`).not.toContain('#');
      expect(url.startsWith('/api/')).toBe(true);

      const headers = (request?.init.headers ?? {}) as Record<string, string>;
      expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('omits credentials, so a cookie can never authenticate a state change', async () => {
    await apiModule.api['me']?.();
    expect(captured.at(-1)?.init.credentials).toBe('omit');
  });

  it('sends no authorization header when there is no token', async () => {
    apiModule.setToken(null);
    await apiModule.api['me']?.();
    const headers = (captured.at(-1)?.init.headers ?? {}) as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });

  /**
   * A 401 is the server saying this credential is invalid, expired or revoked.
   *
   * Keeping it left the console holding a dead token: every screen failed the
   * same way, the operator was never returned to the sign-in form, and a token
   * the issuer had just revoked stayed in browser storage until the tab closed.
   */
  it('discards the token when the server rejects it', async () => {
    respondWith = () => ({
      status: 401,
      body: JSON.stringify({ title: 'Unauthorized', detail: 'token revoked' }),
    });
    await expect(apiModule.api['me']?.()).rejects.toThrow(/revoked/);
    expect(apiModule.getToken()).toBeNull();
    expect([...store.values()]).toEqual([]);
  });

  it('keeps the token when the failure is about permission, not identity', async () => {
    respondWith = () => ({
      status: 403,
      body: JSON.stringify({ title: 'Forbidden', detail: 'this action requires: PREPARER' }),
    });
    await expect(apiModule.api['openPeriod']?.('2026-03-01', '2026-03-31')).rejects.toThrow(
      /PREPARER/,
    );
    expect(apiModule.getToken()).toBe(TOKEN);
  });

  it('surfaces a server error instead of a blank screen, without trusting its shape', async () => {
    respondWith = () => ({ status: 500, body: 'not json at all' });
    await expect(apiModule.api['periods']?.()).rejects.toThrow(/malformed response/i);
  });

  it('reports a problem document as a readable message with its correlation id', async () => {
    respondWith = () => ({
      status: 422,
      body: JSON.stringify({
        title: 'Unprocessable Entity',
        detail: 'a critical breach is unresolved',
        correlationId: 'corr-1',
      }),
    });
    const error = await apiModule.api['publish']?.('11111111-1111-1111-1111-111111111111').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(apiModule.ApiError);
    const problem = error as InstanceType<OperatorApiModule['ApiError']>;
    expect(problem.status).toBe(422);
    expect(problem.message).toBe('a critical breach is unresolved');
    expect(problem.correlationId).toBe('corr-1');
  });

  it('treats an empty 204 as no content rather than a parse failure', async () => {
    respondWith = () => ({ status: 204, body: '' });
    await expect(apiModule.api['me']?.()).resolves.toBeNull();
  });

  it('never writes the credential to a log', () => {
    for (const name of ['app.mjs', 'api.mjs', 'ui.mjs'] as const) {
      expect(withoutComments(SOURCES[name] ?? '')).not.toMatch(/\bconsole\s*\./);
    }
    // And it is never handed to a durable store or a cookie.
    expect(SOURCES['api.mjs'] ?? '').not.toMatch(/localStorage|document\.cookie/);
    expect(withoutComments(SOURCES['app.mjs'] ?? '')).not.toMatch(/getToken\s*\(\s*\)\s*[,)]/);
  });
});

// ---------------------------------------------------------------------------
// The served page: CSP and asset wiring
// ---------------------------------------------------------------------------

const available = await databaseAvailable();

let server: TestServer;
let app: FastifyInstance;

// One instance for the whole file. Closing it in a per-describe hook would shut
// the server down halfway through the file and leave the later suites failing
// for a reason that has nothing to do with what they assert.
afterAll(async () => {
  if (server !== undefined) await server.app.close();
});

describe.skipIf(!available)('the served console', () => {
  beforeEach(async () => {
    await resetDatabase();
    await testPool().query('TRUNCATE api_tokens, users CASCADE');
    await seedTenant();
    server ??= await createTestServer();
    app = server.app;
  });

  it('ships a CSP that forbids inline and third-party script', async () => {
    const response = await app.inject({ method: 'GET', url: '/operator' });
    expect(response.statusCode).toBe(200);

    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");

    const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toMatch(/https?:/);
    expect(csp).not.toContain('unsafe-eval');
  });

  /**
   * The other half of the CSP question.
   *
   * A policy that forbids inline script silently breaks any `onclick=` on the
   * page: the handler simply never runs, with no error the operator would see.
   * This project has already shipped one silent console failure of exactly that
   * shape.
   */
  it('has no inline script and no inline event handlers to be broken by it', async () => {
    const html = (await app.inject({ method: 'GET', url: '/operator' })).body;

    for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
      expect(tag[0]).toMatch(/\ssrc\s*=/);
    }
    // No script body between the tags.
    for (const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      expect((block[1] ?? '').trim()).toBe('');
    }
    for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
      expect(tag[0]).not.toMatch(/\son[a-z]+\s*=/i);
    }
    expect(html).not.toMatch(/javascript:/i);
    // The one thing `style-src 'unsafe-inline'` is there for.
    expect(html).toMatch(/<style>/);
    expect(html).not.toMatch(/<link\b/i);
  });

  /**
   * Every reference must resolve to something the server serves — checked
   * against the base a browser would actually use, which is not the same base
   * for both kinds of reference.
   *
   * An earlier version of this test required every reference to begin
   * `/operator/`. That is right for a `<script src>` and wrong for an `import`.
   * A `src` resolves against the DOCUMENT, so on a page served at `/operator`
   * with no trailing slash a relative one resolves to `/app.mjs` — the bug the
   * portal shipped, which fails silently with no console message. A module
   * specifier resolves against the IMPORTING MODULE's own URL, so from
   * `/operator/app.mjs` a relative `./api.mjs` reaches `/operator/api.mjs`
   * exactly as an absolute path would.
   *
   * Pinning the absolute form for both mistook the remedy for the requirement,
   * and it had a cost: it kept `app.mjs` unimportable by Node, which is why 763
   * lines carrying every role gate and the signing panel were verified by
   * grepping their source text. Resolving each reference the way a browser would
   * and fetching the result tests the property itself, and catches the original
   * bug either way.
   */
  it('resolves every reference the way a browser would, from the right base', async () => {
    const html = (await app.inject({ method: 'GET', url: '/operator' })).body;
    const referenced: { spec: string; base: string }[] = [];

    // Document-relative: the page is served at `/operator`, no trailing slash.
    for (const tag of html.matchAll(/<script\b[^>]*\ssrc\s*=\s*"([^"]+)"/gi)) {
      referenced.push({ spec: tag[1] ?? '', base: 'http://localhost/operator' });
    }
    // Module-relative: each specifier resolves against its own module's URL.
    for (const name of ['app.mjs', 'api.mjs', 'ui.mjs'] as const) {
      for (const spec of (SOURCES[name] ?? '').matchAll(/from\s+'([^']+)'/g)) {
        referenced.push({ spec: spec[1] ?? '', base: `http://localhost/operator/${name}` });
      }
    }

    expect(referenced.length).toBeGreaterThan(0);
    for (const { spec, base } of referenced) {
      const resolved = new URL(spec, base).pathname;
      const asset = await app.inject({ method: 'GET', url: resolved });
      expect(`${spec} -> ${resolved}: ${asset.statusCode}`).toBe(`${spec} -> ${resolved}: 200`);
      expect(asset.headers['content-type']).toContain('text/javascript');
    }
  });

  it('serves exactly the bytes that were scanned above', async () => {
    for (const name of ['app.mjs', 'api.mjs', 'ui.mjs'] as const) {
      const served = await app.inject({ method: 'GET', url: `/operator/${name}` });
      expect(served.body).toBe(SOURCES[name]);
    }
    // The type declaration beside them is not a route: an allow-list, not a
    // directory server.
    expect((await app.inject({ method: 'GET', url: '/operator/ui.d.mts' })).statusCode).toBe(404);
  });

  it('serves the shell without a credential but no tenant data', async () => {
    expect((await app.inject({ method: 'GET', url: '/operator' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/periods' })).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Hidden buttons are not controls
// ---------------------------------------------------------------------------

describe.skipIf(!available)('the server refuses what the console merely hides', () => {
  let viewer: TestUser;
  let preparer: TestUser;
  let compliance: TestUser;

  beforeEach(async () => {
    await resetDatabase();
    await testPool().query('TRUNCATE api_tokens, users CASCADE');
    await seedTenant();
    await seedBackedPeriod();
    server ??= await createTestServer();
    app = server.app;

    viewer = await seedUser({ roles: ['VIEWER'], email: 'viewer@acme.test' });
    preparer = await seedUser({ roles: ['PREPARER'], email: 'prep@acme.test' });
    compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'comp@acme.test' });
  });

  async function openPeriod(user: TestUser): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/periods',
      headers: bearer(user),
      payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  async function generateVersion(user: TestUser, periodId: string): Promise<string> {
    const generated = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(user),
    });
    expect(generated.statusCode).toBe(201);
    return generated.json().versionId as string;
  }

  it('refuses to open a period for a VIEWER, whose console hides the form', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/periods',
      headers: bearer(viewer),
      payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/PREPARER/);
  });

  it('refuses report generation for a VIEWER', async () => {
    const periodId = await openPeriod(preparer);
    const response = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(viewer),
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses publication for a PREPARER, whose console hides the button', async () => {
    const periodId = await openPeriod(preparer);
    const response = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(preparer),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/COMPLIANCE/);
  });

  it('refuses a signature for a role the caller does not hold', async () => {
    const periodId = await openPeriod(preparer);
    const versionId = await generateVersion(preparer, periodId);

    for (const [user, role] of [
      [compliance, 'CFO'],
      [compliance, 'CEO'],
      [viewer, 'PREPARER'],
      [preparer, 'COMPLIANCE'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reports/${versionId}/approvals`,
        headers: bearer(user),
        payload: { role, decision: 'APPROVED' },
      });
      expect(`${role}:${response.statusCode}`).toBe(`${role}:403`);
      expect(response.json().detail).toMatch(new RegExp(`do not hold the ${role} role`));
    }
  });

  it('refuses every gated action outright without a credential', async () => {
    const periodId = await openPeriod(preparer);
    const versionId = await generateVersion(preparer, periodId);

    const gated = [
      { method: 'POST' as const, url: '/api/periods' },
      { method: 'POST' as const, url: `/api/periods/${periodId}/report` },
      { method: 'POST' as const, url: `/api/periods/${periodId}/publish` },
      { method: 'POST' as const, url: `/api/reports/${versionId}/approvals` },
      { method: 'POST' as const, url: '/api/auth/step-up' },
    ];
    for (const call of gated) {
      const response = await app.inject({ ...call, payload: {} });
      expect(`${call.url}:${response.statusCode}`).toBe(`${call.url}:401`);
    }
  });

  it('sends the collateralization ratio as a decimal string at a fixed precision', async () => {
    const periodId = await openPeriod(preparer);
    const response = await app.inject({
      method: 'GET',
      url: `/api/periods/${periodId}/computation`,
      headers: bearer(preparer),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    // Not a JSON number anywhere in the money path, and the exact shape the
    // console's formatters are tested against.
    expect(typeof body.collateralizationRatio).toBe('string');
    expect(body.collateralizationRatio).toMatch(/^-?\d+\.\d{4}$/);
    expect(typeof body.totalReserveValueUsd).toBe('string');
    expect(body.totalReserveValueUsd).toMatch(/^-?\d+\.\d{2}$/);
    // The seeded period holds $10.5m against $10m outstanding.
    expect(ratioToPercent(body.collateralizationRatio)).toBe('105.00%');
    expect(usd(body.totalReserveValueUsd)).toBe('$10,500,000.00');
  });
});
