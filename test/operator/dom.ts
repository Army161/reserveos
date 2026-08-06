/**
 * A DOM double good enough to run the real operator console.
 *
 * `src/operator/app.mjs` is 763 lines carrying every role gate, the signing
 * panel, the critical-breach block and every money-rendering call site, and
 * until now no test could load it: it imported `'/operator/api.mjs'`, which a
 * browser resolves against the origin and Node resolves against the filesystem
 * root. So the file was verified by grepping its source text, which passes for
 * any change that keeps the grepped substrings present. Those imports are now
 * relative, and this is what they load into.
 *
 * jsdom is deliberately still not a dependency. What the console needs is small
 * and worth stating explicitly: nodes that hold children, text that holds a
 * string, and an `appendChild` that refuses anything which is not a node. That
 * last point is the whole reason a double is safe here — it never parses markup,
 * so a test cannot accidentally prove the absence of an injection sink that a
 * real browser would have honoured. Markup sinks are proved separately, by
 * reading the bytes the server ships.
 */

import { vi } from 'vitest';

export class FakeNode {
  readonly childNodes: FakeNode[] = [];

  appendChild(child: unknown): FakeNode {
    // The browser's contract, reproduced exactly: a non-Node is a TypeError, not
    // a stringified child. Softening this would invent behaviour the page lacks.
    if (!(child instanceof FakeNode)) {
      throw new TypeError(
        "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
      );
    }
    this.childNodes.push(child);
    return child;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: unknown[]): void {
    this.childNodes.length = 0;
    for (const node of nodes) this.appendChild(node);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
}

export class FakeText extends FakeNode {
  constructor(readonly data: string) {
    super();
  }

  override get textContent(): string {
    return this.data;
  }
}

export class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  /** Kept so a test can drive a control the way an operator would. */
  readonly listeners = new Map<string, ((event?: unknown) => unknown)[]>();
  className = '';
  disabled = false;
  checked = false;

  constructor(readonly tagName: string) {
    super();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, handler: (event?: unknown) => unknown): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) this.listeners.set(type, [handler]);
    else existing.push(handler);
  }

  /** Fire every handler registered for `type`, awaiting async ones. */
  async dispatch(type: string): Promise<void> {
    for (const handler of this.listeners.get(type) ?? []) await handler();
  }
}

export function walk(node: FakeNode): FakeNode[] {
  return node.childNodes.flatMap((child) => [child, ...walk(child)]);
}

export function elements(node: FakeNode): FakeElement[] {
  return walk(node).filter((child): child is FakeElement => child instanceof FakeElement);
}

export function textNodes(node: FakeNode): FakeText[] {
  return walk(node).filter((child): child is FakeText => child instanceof FakeText);
}

/** Every element whose class list contains `name`. */
export function byClass(node: FakeNode, name: string): FakeElement[] {
  return elements(node).filter((element) => element.className.split(/\s+/).includes(name));
}

export interface InstalledDom {
  readonly root: FakeElement;
  readonly nav: FakeElement;
  readonly identity: FakeElement;
  /** Requests the page made, in order, so a test can assert what it did NOT ask for. */
  readonly requests: { method: string; path: string }[];
  setHash(hash: string): void;
  restore(): void;
}

export interface DomOptions {
  /** Initial `location.hash`, e.g. `#/reports/<id>/certify`. */
  readonly hash?: string;
  /** Token in sessionStorage. Absent means signed out. */
  readonly token?: string;
  /**
   * Answers keyed by `METHOD /path`. A request with no entry is a test failure
   * rather than a 404: the point of several of these tests is that the console
   * does not call an endpoint at all, and a silent 404 would hide that.
   */
  readonly routes: Record<string, unknown>;
}

const KEYS = ['document', 'window', 'location', 'sessionStorage', 'fetch'] as const;

/**
 * Install the globals `app.mjs` expects, and return handles to inspect.
 *
 * Call `restore()` in an `afterEach`; the globals are process-wide.
 */
export function installDom(options: DomOptions): InstalledDom {
  const holder = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const key of KEYS) saved.set(key, holder[key]);

  const root = new FakeElement('div');
  const nav = new FakeElement('nav');
  const identity = new FakeElement('div');
  const byId: Record<string, FakeElement> = { root, nav, identity };

  const requests: { method: string; path: string }[] = [];
  const store = new Map<string, string>();
  if (options.token !== undefined) store.set('reserveos.token', options.token);

  const locationStub = { hash: options.hash ?? '' };

  holder['document'] = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
    getElementById: (id: string) => byId[id] ?? null,
  };
  holder['window'] = { addEventListener: () => undefined };
  holder['location'] = locationStub;
  holder['sessionStorage'] = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

  holder['fetch'] = async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, path });

    const key = `${method} ${path}`;
    if (!(key in options.routes)) {
      throw new Error(
        `the console requested ${key}, which this test did not stub. ` +
          `Stubbed: ${Object.keys(options.routes).join(', ') || '(none)'}`,
      );
    }

    const body = options.routes[key];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };

  return {
    root,
    nav,
    identity,
    requests,
    setHash: (hash: string) => {
      locationStub.hash = hash;
    },
    restore: () => {
      for (const key of KEYS) {
        const previous = saved.get(key);
        if (previous === undefined) delete holder[key];
        else holder[key] = previous;
      }
    },
  };
}

/**
 * Import `app.mjs` fresh.
 *
 * The module self-boots on import — it reads the token, fetches the session and
 * renders — and has no exports, so driving it means importing it with the
 * globals already in place. `resetModules` is what makes a second scenario
 * possible: the previous instance holds `session` in module scope, and a cached
 * import would render nothing at all the second time. It resets `api.mjs` too,
 * which is wanted — the token is read at call time from whichever
 * `sessionStorage` is installed now.
 */
export async function bootConsole(): Promise<void> {
  vi.resetModules();
  await import('../../src/operator/app.mjs');
}
