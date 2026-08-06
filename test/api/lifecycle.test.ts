import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from '../db/harness.js';
import {
  bearer,
  createTestServer,
  seedBackedPeriod,
  seedUser,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { verifyResponse } from '../../src/portal/verify-client.mjs';
import { withPublicRole } from '../../src/db/pool.js';
import { canonicalHash } from '../../src/domain/canonical.js';

/**
 * The full statutory cycle over HTTP, ending in independent verification.
 *
 * The last steps are the point of the whole system: an unauthenticated caller
 * fetches a published report and the browser verification module — the same file
 * the examiner's browser downloads — confirms every hash without trusting a
 * single field the server asserted about validity.
 */

const available = await databaseAvailable();

let server: TestServer;
let app: FastifyInstance;

describe.skipIf(!available)('monthly cycle over HTTP', () => {
  let preparer: TestUser;
  let compliance: TestUser;
  let cfo: TestUser;
  let ceo: TestUser;

  beforeEach(async () => {
    await resetDatabase();
    await testPool().query('TRUNCATE api_tokens, users CASCADE');
    await seedTenant();
    await seedBackedPeriod();
    server ??= await createTestServer();
    app = server.app;

    preparer = await seedUser({ roles: ['PREPARER'], email: 'prep@acme.test' });
    compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'comp@acme.test' });
    cfo = await seedUser({ roles: ['CFO'], email: 'cfo@acme.test', stepUp: true });
    ceo = await seedUser({ roles: ['CEO'], email: 'ceo@acme.test', stepUp: true });
  });

  afterAll(async () => {
    if (server !== undefined) await server.app.close();
  });

  async function openPeriod(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/periods',
      headers: bearer(preparer),
      payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function generateReport(periodId: string): Promise<{ versionId: string; hash: string }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(preparer),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.criticalBreaches).toBe(0);
    return { versionId: body.versionId, hash: body.payloadHash };
  }

  async function approve(user: TestUser, versionId: string, role: string) {
    return app.inject({
      method: 'POST',
      url: `/api/reports/${versionId}/approvals`,
      headers: bearer(user),
      payload: { role, decision: 'APPROVED' },
    });
  }

  async function certify(versionId: string): Promise<void> {
    for (const [user, role] of [
      [preparer, 'PREPARER'],
      [compliance, 'COMPLIANCE'],
      [cfo, 'CFO'],
      [ceo, 'CEO'],
    ] as const) {
      const response = await approve(user, versionId, role);
      expect(response.statusCode, `${role} approval: ${response.body}`).toBe(201);
    }
  }

  it('runs open -> report -> certify -> publish -> independently verify', async () => {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);

    await certify(versionId);

    const period = await app.inject({
      method: 'GET',
      url: `/api/periods/${periodId}`,
      headers: bearer(preparer),
    });
    expect(period.json().status).toBe('CERTIFIED');

    const published = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });
    expect(published.statusCode).toBe(200);

    // --- Unauthenticated verification -------------------------------------
    const verify = await app.inject({ method: 'GET', url: `/verify/${hash}` });
    expect(verify.statusCode).toBe(200);
    const payload = verify.json();

    // The server never claims validity; it supplies the material to check.
    expect(payload).not.toHaveProperty('verified');
    expect(payload.disclosure).toBeDefined();
    expect(payload.anchor.status).toBe('CONFIRMED');
    expect(payload.anchor.transactionHash).toMatch(/^0x/);

    // --- The examiner's browser does the work ------------------------------
    const result = await verifyResponse(payload, hash);
    for (const check of result.checks) {
      expect(check.passed, `${check.id}: expected ${check.expected}, got ${check.actual}`).toBe(
        true,
      );
    }
    expect(result.allPassed).toBe(true);

    // The one thing the page cannot settle is surfaced as an action, not a pass.
    expect(result.independentStep).not.toBeNull();
    expect(result.independentStep?.instruction).toMatch(/yourself/i);
  });

  it('detects a tampered disclosure', async () => {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);
    await certify(versionId);
    await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });

    const verify = await app.inject({ method: 'GET', url: `/verify/${hash}` });
    const payload = verify.json();

    // Someone edits the headline reserve figure in transit.
    payload.disclosure.reserves.totalMarketValueUsd = '99999999.00';

    const result = await verifyResponse(payload, hash);
    expect(result.allPassed).toBe(false);
    expect(result.checks.find((c) => c.id === 'disclosure-hash')?.passed).toBe(false);
  });

  it('detects a swapped commitment', async () => {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);
    await certify(versionId);
    await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });

    const payload = (await app.inject({ method: 'GET', url: `/verify/${hash}` })).json();
    payload.anchor.merkleRoot = 'f'.repeat(64);

    const result = await verifyResponse(payload, hash);
    expect(result.allPassed).toBe(false);
    expect(result.checks.find((c) => c.id === 'anchor-match')?.passed).toBe(false);
  });

  it('does not expose an unpublished report to the public endpoint', async () => {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);

    // Certified but not yet published.
    await certify(versionId);

    const verify = await app.inject({ method: 'GET', url: `/verify/${hash}` });
    // Indistinguishable from a hash that never existed: the existence of an
    // uncertified or unpublished period is not public information.
    expect(verify.statusCode).toBe(404);
  });

  it('never exposes lineage or breach detail through the public endpoint', async () => {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);
    await certify(versionId);
    await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });

    const body = (await app.inject({ method: 'GET', url: `/verify/${hash}` })).body;
    expect(body).not.toContain('lineage');
    expect(body).not.toContain('contributingFactIds');
    expect(body).not.toContain('reservesByCustodian');
    // Custodian names are internal; only jurisdictions are disclosed.
    expect(body).not.toContain('BNY Mellon');
  });

  /** Certify and publish, returning the certified report hash. */
  async function publishedHash(): Promise<string> {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);
    await certify(versionId);
    const published = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });
    expect(published.statusCode).toBe(200);
    return hash;
  }

  it('does not report a published-but-unanchored report as ledger-confirmed', async () => {
    const hash = await publishedHash();

    // PENDING with no transaction hash is a real state, not a contrivance: the
    // anchor row is written with its merkle root before Kaleido confirms, and
    // `publishPeriod` does not wait for confirmation. `EvidenceService.anchor`
    // leaves exactly this row when submission throws.
    await testPool().query(
      `UPDATE anchors SET status = 'PENDING', besu_tx_hash = NULL, besu_block_number = NULL,
                          anchored_at = NULL
        WHERE subject_type = 'REPORT_VERSION'`,
    );

    const payload = (await app.inject({ method: 'GET', url: `/verify/${hash}` })).json();
    expect(payload.anchor.status).toBe('PENDING');
    expect(payload.anchor.transactionHash).toBeNull();

    const result = await verifyResponse(payload, hash);
    // The commitment still matches the stored root, so every hash check passes.
    expect(result.checks.find((c) => c.id === 'anchor-match')?.passed).toBe(true);
    // But nothing is on the ledger, and there is no transaction to look up, so
    // the page must not render a clean pass.
    expect(result.allPassed).toBe(false);
    expect(result.independentStep).toBeNull();
  });

  it('refuses a verification response that answers a different hash', async () => {
    const hash = await publishedHash();
    const payload = (await app.inject({ method: 'GET', url: `/verify/${hash}` })).json();

    // A malicious server can pick the disclosure, its hash, the commitment and
    // the anchor root together, so all five internal checks agree. The examiner's
    // hash, read off the signed report, is the only external input.
    const result = await verifyResponse(payload, 'c'.repeat(64));
    expect(result.allPassed).toBe(false);
    expect(result.checks.find((c) => c.id === 'requested-hash')?.passed).toBe(false);
  });

  it('resolves only the certified report hash, not the disclosure hash', async () => {
    const hash = await publishedHash();
    const payload = (await app.inject({ method: 'GET', url: `/verify/${hash}` })).json();

    // `report_versions` is indexed on payload_hash and stores no disclosure hash,
    // so a disclosure hash cannot be resolved without a full scan. Pinned here so
    // the portal's copy and the route comment cannot drift back into promising it.
    const byDisclosure = await app.inject({
      method: 'GET',
      url: `/verify/${payload.disclosureHash}`,
    });
    expect(byDisclosure.statusCode).toBe(404);
  });

  it('confines the public role to published report material', async () => {
    const hash = await publishedHash();

    // A second, still-draft period so there is something to be denied.
    const draftPeriod = await app.inject({
      method: 'POST',
      url: '/api/periods',
      headers: bearer(preparer),
      payload: { periodStart: '2026-04-01', periodEnd: '2026-04-30' },
    });
    expect(draftPeriod.statusCode).toBe(201);
    const draft = await generateReport(draftPeriod.json().id as string);
    expect(draft.hash).not.toBe(hash);

    // Anchors over a daily rollup and over an approval exist alongside the
    // report anchor; both reveal ingestion cadence and signing activity.
    await testPool().query(
      `INSERT INTO anchors (issuer_id, subject_type, subject_id, merkle_root, status)
       VALUES ($1, 'DAILY_ROLLUP', gen_random_uuid(), $2, 'CONFIRMED'),
              ($1, 'APPROVAL',     gen_random_uuid(), $3, 'CONFIRMED')`,
      [SEED_IDS.issuerId, 'e'.repeat(64), 'f'.repeat(64)],
    );

    await withPublicRole(server.pool, async (client) => {
      /** Each denial aborts the transaction, so isolate it in a savepoint. */
      async function denied(sql: string): Promise<string> {
        await client.query('SAVEPOINT probe');
        try {
          await client.query(sql);
          return '(allowed)';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT probe');
        }
      }

      // Unpublished versions and their periods are invisible.
      const versions = await client.query(`SELECT id, payload_hash FROM report_versions`);
      expect(versions.rows.map((r) => r.payload_hash)).toEqual([hash]);

      const periods = await client.query(`SELECT id, status FROM reporting_periods`);
      expect(periods.rows.map((r) => r.status)).toEqual(['PUBLISHED']);

      const anchors = await client.query(`SELECT subject_type FROM anchors`);
      expect(anchors.rows.map((r) => r.subject_type)).toEqual(['REPORT_VERSION']);

      // Tables the role holds no grant on at all.
      for (const table of [
        'custodians',
        'reserve_facts',
        'supply_facts',
        'approvals',
        'redemption_requests',
        'source_documents',
        'access_log',
        'token_deployments',
        'fx_rates',
        'users',
        'api_tokens',
      ]) {
        expect(await denied(`SELECT * FROM ${table} LIMIT 1`), table).toMatch(/permission denied/i);
      }

      // Columns withheld even on readable tables.
      expect(await denied(`SELECT kaleido_env_id FROM issuers`)).toMatch(/permission denied/i);
      expect(await denied(`SELECT generated_by FROM report_versions`)).toMatch(
        /permission denied/i,
      );

      // Writing anything at all is refused, so the append-only evidence tables
      // cannot be appended to by an unauthenticated caller either.
      expect(
        await denied(
          `INSERT INTO anchors (issuer_id, subject_type, subject_id, merkle_root, status)
           VALUES ('${SEED_IDS.issuerId}', 'REPORT_VERSION', gen_random_uuid(),
                   '${'a'.repeat(64)}', 'CONFIRMED')`,
        ),
      ).toMatch(/permission denied/i);
    });
  });

  it('survives a deeply nested payload posted to the canonicalization helper', async () => {
    // `canonicalize` is recursive and the body limit is 1 MiB, so 10 KB of '['
    // reaches ~5000 frames. This must be a stated refusal, not a stack overflow
    // surfacing as a 500 or leaking an engine message.
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    const response = await app.inject({
      method: 'POST',
      url: '/verify/canonicalize',
      headers: { 'content-type': 'application/json' },
      payload: deep,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().detail).not.toMatch(/call stack/i);
    expect(response.json().detail).toMatch(/nest|deep/i);

    // Depth a real disclosure reaches is still accepted.
    const shallow = await app.inject({
      method: 'POST',
      url: '/verify/canonicalize',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ b: 'two', a: { deep: [{ x: ['y'] }] } }),
    });
    expect(shallow.statusCode).toBe(200);
    expect(shallow.json().canonicalJson).toBe('{"a":{"deep":[{"x":["y"]}]},"b":"two"}');
    // Hashing the canonical string once must equal canonicalizing twice.
    expect(shallow.json().sha256).toBe(canonicalHash({ b: 'two', a: { deep: [{ x: ['y'] }] } }));

    // The process is still serving.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('requires step-up authentication for executive certification', async () => {
    const weakCfo = await seedUser({ roles: ['CFO'], email: 'weak@acme.test', stepUp: false });
    const periodId = await openPeriod();
    const { versionId } = await generateReport(periodId);

    await approve(preparer, versionId, 'PREPARER');
    await approve(compliance, versionId, 'COMPLIANCE');

    const response = await approve(weakCfo, versionId, 'CFO');
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/step-up/i);
  });

  it('enforces the approval order', async () => {
    const periodId = await openPeriod();
    const { versionId } = await generateReport(periodId);

    const response = await approve(ceo, versionId, 'CEO');
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/PREPARER must act before CEO/);
  });

  it('refuses a role the caller does not hold', async () => {
    const periodId = await openPeriod();
    const { versionId } = await generateReport(periodId);

    const response = await approve(preparer, versionId, 'CEO');
    expect(response.statusCode).toBe(403);
  });

  it('blocks certification while a critical breach is open', async () => {
    // Remove one chain's supply observation: outstanding is understated, which
    // inflates the collateralization ratio.
    await testPool().query(`DELETE FROM supply_facts WHERE token_deployment_id = $1`, [
      SEED_IDS.base,
    ]);

    const periodId = await openPeriod();
    const generated = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(preparer),
    });
    expect(generated.json().criticalBreaches).toBeGreaterThan(0);

    const response = await approve(preparer, generated.json().versionId, 'PREPARER');
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toMatch(/critical breach/i);
  });

  it('returns the existing version when nothing has changed', async () => {
    const periodId = await openPeriod();
    const first = await generateReport(periodId);
    // Same facts, same clock: byte-identical figures. A second version here
    // would renumber unchanged data and invalidate an approval chain underway.
    const again = await generateReport(periodId);

    expect(again.versionId).toBe(first.versionId);
    expect(again.hash).toBe(first.hash);
  });

  it('refuses to certify a superseded version', async () => {
    const periodId = await openPeriod();
    const first = await generateReport(periodId);

    // A late custodian statement arrives, so the figures genuinely change.
    await testPool().query(
      `INSERT INTO reserve_facts
         (issuer_id, custodian_id, as_of, observed_at, instrument_category, cusip, currency,
          face_value_minor, market_value_minor, maturity_date, source_hash)
       VALUES ($1, $2, $3, $3, 'CASH', NULL, 'USD', 5000000, 5000000, NULL, $4)`,
      [SEED_IDS.issuerId, SEED_IDS.euroclear, new Date('2026-03-31T20:00:00.000Z'), 'e'.repeat(64)],
    );

    const second = await generateReport(periodId);
    expect(second.versionId).not.toBe(first.versionId);

    const response = await approve(preparer, first.versionId, 'PREPARER');
    expect(response.statusCode).toBe(409);
    expect(response.json().detail).toMatch(/superseded/);
  });

  it('refuses to publish a period that is not certified', async () => {
    const periodId = await openPeriod();
    await generateReport(periodId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });
    expect(response.statusCode).toBe(422);
  });

  it('serves the portal and its verification source', async () => {
    const page = await app.inject({ method: 'GET', url: '/portal' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");

    const script = await app.inject({ method: 'GET', url: '/portal/verify-client.mjs' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    // The examiner must be able to read what ran, so this is source, not a bundle.
    expect(script.body).toContain('export function canonicalize');
  });

  it.each(['/portal', '/operator'])(
    'resolves every asset %s actually references',
    async (page) => {
      // The bug this catches: `src="./app.mjs"` on a page served at `/portal`
      // resolves to `/app.mjs`, not `/portal/app.mjs`. Asserting that the endpoint
      // exists is not the same as asserting the page can reach it, and the page
      // silently did nothing at all — no error, no console message.
      const html = await app.inject({ method: 'GET', url: page });
      expect(html.statusCode).toBe(200);

      const references = [...html.body.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((url) => !/^(https?:)?\/\//.test(url));

      expect(references.length).toBeGreaterThan(0);

      for (const reference of references) {
        const resolved = new URL(reference, `http://localhost${page}`).pathname;
        const response = await app.inject({ method: 'GET', url: resolved });
        expect(response.statusCode, `${reference} resolved to ${resolved}`).toBe(200);
      }
    },
  );

  it('resolves every module the console imports, transitively', async () => {
    // Module specifiers have the same resolution trap as `src`, and a broken one
    // fails silently in exactly the same way.
    const seen = new Set<string>();
    const queue = ['/operator/app.mjs'];

    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);

      const module = await app.inject({ method: 'GET', url: path });
      expect(module.statusCode, `${path} is not served`).toBe(200);

      for (const match of module.body.matchAll(/from\s+'([^']+)'/g)) {
        const resolved = new URL(match[1]!, `http://localhost${path}`).pathname;
        queue.push(resolved);
      }
    }

    expect(seen).toContain('/operator/api.mjs');
    expect(seen).toContain('/operator/ui.mjs');
  });

  it('serves the console shell without a credential, so sign-in can render', async () => {
    for (const path of ['/operator', '/operator/app.mjs', '/operator/api.mjs', '/operator/ui.mjs']) {
      // Including with a stale token: the page that renders the sign-in form
      // must not itself require a working credential.
      const stale = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: 'Bearer rsos_expired-token' },
      });
      expect(stale.statusCode, path).toBe(200);
    }
  });

  it('exposes no tenant data through the console assets', async () => {
    for (const path of ['/operator', '/operator/app.mjs', '/operator/api.mjs', '/operator/ui.mjs']) {
      const body = (await app.inject({ method: 'GET', url: path })).body;
      expect(body).not.toContain('Acme Digital Trust');
      expect(body).not.toContain(SEED_IDS.issuerId);
    }
  });

  it('imports the verification module by a path the browser can resolve', async () => {
    const script = await app.inject({ method: 'GET', url: '/portal/app.mjs' });
    expect(script.statusCode).toBe(200);

    const imports = [...script.body.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);
    for (const specifier of imports) {
      const resolved = new URL(specifier, 'http://localhost/portal/app.mjs').pathname;
      const response = await app.inject({ method: 'GET', url: resolved });
      expect(response.statusCode, `${specifier} resolved to ${resolved}`).toBe(200);
    }
  });

  it('builds the portal DOM without any HTML sink', async () => {
    // Every value rendered on this page is server-controlled and some of it —
    // issuer legal name, regulator, category labels — is issuer-authored text.
    // The page is safe because it builds nodes rather than markup, and the CSP
    // is not what makes it safe. Both are asserted, because either alone can rot.
    const script = (await app.inject({ method: 'GET', url: '/portal/app.mjs' })).body;
    for (const sink of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
      'setHTML',
    ]) {
      expect(script, `app.mjs must not use ${sink}`).not.toContain(sink);
    }

    const page = await app.inject({ method: 'GET', url: '/portal' });
    const csp = page.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(csp).toContain("base-uri 'none'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    // A `script-src 'self'` policy is only meaningful if the page has no inline
    // script for it to have been relaxed for.
    expect(page.body).not.toMatch(/<script(?![^>]*\ssrc=)/i);
  });

  it('rejects a path-traversal attempt at the portal asset routes', async () => {
    for (const attempt of [
      '/portal/../package.json',
      '/portal/%2e%2e/package.json',
      '/portal/verify-client.d.mts',
    ]) {
      const response = await app.inject({ method: 'GET', url: attempt });
      expect(response.statusCode, attempt).not.toBe(200);
    }
  });
});
