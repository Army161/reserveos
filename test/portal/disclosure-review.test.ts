import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from '../db/harness.js';
import {
  bearer,
  createTestServer,
  seedBackedPeriod,
  seedUser,
  type TestServer,
  type TestUser,
} from '../api/helpers.js';
import {
  canonicalize as browserCanonicalize,
  canonicalHash as browserCanonicalHash,
  commitmentOf,
  verifyResponse,
} from '../../src/portal/verify-client.mjs';
import { canonicalize as serverCanonicalize } from '../../src/domain/canonical.js';
import type { CanonicalValue } from '../../src/domain/canonical.js';

/**
 * Adversarial review of the public disclosure surface.
 *
 * Three things are tested here and they differ in kind:
 *
 *  1. That the browser refuses responses a malicious server can construct. The
 *     hostile party is OUR OWN SERVER, so a check comparing one server-supplied
 *     field against another server-supplied field establishes nothing.
 *  2. That `/verify/:hash` cannot be steered into unpublished or cross-tenant
 *     material, and that its refusal carries no information.
 *  3. That `howToVerify` is not merely true but SUFFICIENT: an examiner who
 *     follows it literally must end up where the instructions claim.
 *
 * `test/portal/verify-client.test.ts` owns browser/server canonicalization
 * equivalence over generated payloads. What is added at the bottom of this file
 * is the input classes that generator cannot reach.
 *
 * Every non-ASCII literal below is written as a `\uXXXX` escape on purpose. The
 * cases that matter here are ones where two different strings are
 * indistinguishable to someone reading the source.
 */

const available = await databaseAvailable();
const PORTAL_DIR = join(process.cwd(), 'src', 'portal');
const APP_MJS = readFileSync(join(PORTAL_DIR, 'app.mjs'), 'utf8');
const INDEX_HTML = readFileSync(join(PORTAL_DIR, 'index.html'), 'utf8');
const VERIFY_CLIENT_MJS = readFileSync(join(PORTAL_DIR, 'verify-client.mjs'), 'utf8');

let server: TestServer;
let app: FastifyInstance;

/** An independent SHA-256, so the endpoint is never checked against its own helper. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe.skipIf(!available)('public disclosure surface', () => {
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

    preparer = await seedUser({ roles: ['PREPARER'], email: 'dr-prep@acme.test' });
    compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'dr-comp@acme.test' });
    cfo = await seedUser({ roles: ['CFO'], email: 'dr-cfo@acme.test', stepUp: true });
    ceo = await seedUser({ roles: ['CEO'], email: 'dr-ceo@acme.test', stepUp: true });
  });

  afterAll(async () => {
    if (server !== undefined) await server.app.close();
  });

  async function openPeriod(start = '2026-03-01', end = '2026-03-31'): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/periods',
      headers: bearer(preparer),
      payload: { periodStart: start, periodEnd: end },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function generateReport(periodId: string): Promise<{ versionId: string; hash: string }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(preparer),
    });
    expect(response.statusCode, response.body).toBe(201);
    return { versionId: response.json().versionId, hash: response.json().payloadHash };
  }

  async function certify(versionId: string): Promise<void> {
    for (const [user, role] of [
      [preparer, 'PREPARER'],
      [compliance, 'COMPLIANCE'],
      [cfo, 'CFO'],
      [ceo, 'CEO'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reports/${versionId}/approvals`,
        headers: bearer(user),
        payload: { role, decision: 'APPROVED' },
      });
      expect(response.statusCode, `${role}: ${response.body}`).toBe(201);
    }
  }

  /** A genuine report: certified, published, anchor confirmed. */
  async function publish(): Promise<{ periodId: string; versionId: string; hash: string }> {
    const periodId = await openPeriod();
    const { versionId, hash } = await generateReport(periodId);
    await certify(versionId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/publish`,
      headers: bearer(compliance),
    });
    expect(response.statusCode, response.body).toBe(200);
    return { periodId, versionId, hash };
  }

  async function fetchVerification(hash: string): Promise<Record<string, any>> {
    const response = await app.inject({ method: 'GET', url: `/verify/${hash}` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  // -------------------------------------------------------------------------
  // 1. What a malicious server can still do
  // -------------------------------------------------------------------------

  describe('what a malicious server can still do', () => {
    it('refuses a genuine disclosure relabelled with a different reporting period', async () => {
      const { hash } = await publish();
      const response = await fetchVerification(hash);

      // `disclosureHash` covers `disclosure` alone. The top-level `period` block
      // is separate server text and it is what the page prints as a heading, so
      // a server can serve March's real, genuinely anchored figures under a June
      // heading: every hash still agrees and the ledger still holds the
      // commitment, because none of it reaches this block.
      expect(response.disclosure.period.start).toBe('2026-03-01');
      response.period.start = '2026-06-01';
      response.period.end = '2026-06-30';

      const result = await verifyResponse(response, hash);
      expect(
        result.allPassed,
        'a relabelled period must not verify: it is what the examiner reads',
      ).toBe(false);
      expect(result.checks.find((c) => c.id === 'period-label')?.passed).toBe(false);
    });

    it('refuses a generation time that disagrees with the hashed disclosure', async () => {
      const { hash } = await publish();
      const response = await fetchVerification(hash);

      // Same class of defect, and "when was this produced" is exactly what a
      // backdated filing would falsify.
      response.period.generatedAt = '2026-04-01T00:00:00.000Z';

      const result = await verifyResponse(response, hash);
      expect(result.allPassed).toBe(false);
      expect(result.checks.find((c) => c.id === 'period-label')?.passed).toBe(false);
    });

    it('does not pass the period check merely because both sides are missing', async () => {
      const { hash } = await publish();
      const response = await fetchVerification(hash);
      delete response.period;
      delete response.disclosure.period;

      const result = await verifyResponse(response, hash);
      expect(result.checks.find((c) => c.id === 'period-label')?.passed).toBe(false);
    });

    it('does not send an examiner to confirm a refused document on the ledger', async () => {
      const { hash } = await publish();

      const clean = await verifyResponse(await fetchVerification(hash), hash);
      expect(clean.allPassed).toBe(true);
      expect(clean.independentStep?.transactionHash).toMatch(/^0x/);

      // The relabelled period again, now looked at from the other end. The
      // figures, every hash and the anchor are genuine — only the dates printed
      // around them are wrong — so `anchor-match` still passes and the
      // commitment this step hands over is the one that really is on chain.
      // Offering it here would walk the examiner through a ledger lookup that
      // SUCCEEDS, for a document the page has just refused, at the one step the
      // instructions call decisive.
      const relabelled = await fetchVerification(hash);
      relabelled.period.start = '2026-06-01';
      relabelled.period.end = '2026-06-30';
      const failed = await verifyResponse(relabelled, hash);
      expect(failed.allPassed).toBe(false);
      expect(failed.checks.find((c) => c.id === 'anchor-match')?.passed).toBe(true);
      expect(failed.checks.find((c) => c.id === 'anchor-confirmed')?.passed).toBe(true);
      expect(
        failed.independentStep,
        'a refused run must hand the examiner no ledger action',
      ).toBeNull();

      // Same for an answer about a report other than the one asked about.
      const other = await verifyResponse(await fetchVerification(hash), 'b'.repeat(64));
      expect(other.checks.find((c) => c.id === 'requested-hash')?.passed).toBe(false);
      expect(other.independentStep).toBeNull();

      // And the page hides the box on exactly that signal.
      expect(APP_MJS).toMatch(/renderIndependentStep\(result\.independentStep\)/);
      expect(APP_MJS).toMatch(/if \(step === null\) \{\s*\n\s*box\.hidden = true;/);
    });

    it('states plainly which part of the response is covered by a hash', async () => {
      const { hash } = await publish();
      const response = await fetchVerification(hash);

      // An examiner must be told which parts of this document are evidence and
      // which are just text we wrote around it.
      const instructions = (response.howToVerify as string[]).join('\n');
      expect(instructions).toMatch(/covers `disclosure` and nothing else/);
      expect(instructions).toMatch(/`period` block/);
    });

    it('cannot detect a wholly invented disclosure that echoes the examiner hash', async () => {
      // The honest statement of the residual gap, pinned so it cannot be
      // overclaimed away. The examiner brings hash H off the signed report. A
      // malicious server invents figures D, claims `certifiedReportHash: H`,
      // sets `disclosure.certifiedReportHash: H`, derives the commitment from H
      // and hash(D), and reports that commitment as a CONFIRMED anchor with a
      // fabricated transaction id. EVERY browser check passes, including the one
      // the examiner supplied the input for, because the certified report itself
      // is never served and nothing in the browser can tie D to H.
      const asked = 'a'.repeat(64);
      const disclosure = {
        schema: 'reserveos.public-disclosure/v1',
        issuer: { id: 'x', legalName: 'Totally Solvent Trust Co', regulator: 'OCC' },
        period: { start: '2026-03-01', end: '2026-03-31', asOf: '2026-03-31T23:59:59.999Z' },
        generatedAt: '2026-04-02T14:30:00.000Z',
        reserves: {
          totalMarketValueUsd: '99999999999.00',
          composition: [],
          custodyByJurisdiction: [],
        },
        outstanding: { totalUsd: '1.00', byChain: [] },
        collateralization: { ratio: '1.0000', ratioPercent: '100.00' },
        certifiedReportHash: asked,
      };
      const disclosureHash = await browserCanonicalHash(disclosure);
      const expected = await commitmentOf(asked, disclosureHash);
      const forged = {
        period: {
          start: disclosure.period.start,
          end: disclosure.period.end,
          version: 1,
          generatedAt: disclosure.generatedAt,
        },
        disclosure,
        disclosureHash,
        certifiedReportHash: asked,
        commitment: { expected, leaves: [asked, disclosureHash] },
        anchor: {
          merkleRoot: expected,
          transactionHash: `0x${'ab'.repeat(32)}`,
          blockNumber: '99',
          anchoredAt: '2026-04-02T14:31:00.000Z',
          status: 'CONFIRMED',
        },
        canonicalJson: browserCanonicalize(disclosure),
      };

      const result = await verifyResponse(forged, asked);
      expect(
        result.allPassed,
        'if this ever becomes false the residual gap has closed, and the wording asserted below can be strengthened',
      ).toBe(true);

      // Because that is true, the page must never present a clean run as proof,
      // and the one step that would close the gap has to be handed over as an
      // action rather than reported as a check that passed.
      expect(result.checks.some((c) => c.id.includes('ledger'))).toBe(false);
      expect(result.independentStep?.instruction).toMatch(/cannot prove it to you/i);
      expect(APP_MJS).toMatch(/Every check this page can make passed/);
      expect(APP_MJS).not.toMatch(/verdict\.textContent\s*=\s*[`'"]Verified/);
    });

    it('cannot detect suppression: a real published report served as a 404', async () => {
      const { hash, periodId } = await publish();
      expect((await app.inject({ method: 'GET', url: `/verify/${hash}` })).statusCode).toBe(200);

      // Withdrawing publication is indistinguishable, from the browser, from a
      // hash that was never issued. There is no client-side defence: the
      // examiner has to notice that a report they hold a hash for stopped
      // resolving. Pinned as a known limit of the design, not as a pass.
      await testPool().query(`UPDATE reporting_periods SET status = 'CERTIFIED' WHERE id = $1`, [
        periodId,
      ]);
      expect((await app.inject({ method: 'GET', url: `/verify/${hash}` })).statusCode).toBe(404);
    });

    it('does not name the ledger the examiner is sent to consult', async () => {
      // Also pinned as a known limitation. The final instruction is "look this
      // transaction up on the ledger yourself", and the anchor block carries a
      // transaction id and a block number but nothing that identifies the chain
      // they are on. `kaleido_env_id` is deliberately withheld from
      // `reserveos_public` (migration 006), so this route cannot supply it
      // without a schema change; the examiner needs it out of band.
      const { hash } = await publish();
      const response = await fetchVerification(hash);
      expect(response.anchor.transactionHash).toMatch(/^0x/);
      expect(Object.keys(response.anchor).sort()).toEqual([
        'anchoredAt',
        'blockNumber',
        'merkleRoot',
        'publicTetherRef',
        'status',
        'transactionHash',
      ]);
      // `publicTetherRef` exists in the schema for exactly this purpose and is
      // written by no code path, so it is always null.
      expect(response.anchor.publicTetherRef).toBeNull();
      expect((response.howToVerify as string[]).at(-1)).toMatch(/on the ledger/);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Unpublished and cross-tenant exposure
  // -------------------------------------------------------------------------

  describe('nothing unpublished is reachable through /verify/:hash', () => {
    /** A 404 body with the per-request correlation id removed. */
    function refusal(body: string): string {
      return JSON.stringify({ ...JSON.parse(body), correlationId: '<redacted>' });
    }

    it('refuses drafts, certified-but-unpublished, other tenants and non-report anchors alike', async () => {
      const { hash } = await publish();

      // (a) a draft period's report version, same tenant
      const draftPeriod = await openPeriod('2026-04-01', '2026-04-30');
      const draft = await generateReport(draftPeriod);
      expect(draft.hash).not.toBe(hash);

      // (b) certified but not published, same tenant. Written directly: the
      //     fixture's facts only support the March period, and what is under
      //     test is the CERTIFIED status, not how the row came to exist.
      const certifiedHash = 'b'.repeat(64);
      const certifiedPeriod = await testPool().query<{ id: string }>(
        `INSERT INTO reporting_periods (issuer_id, period_start, period_end, status)
         VALUES ($1, '2026-02-01', '2026-02-28', 'CERTIFIED') RETURNING id`,
        [SEED_IDS.issuerId],
      );
      await testPool().query(
        `INSERT INTO report_versions (period_id, version, payload, payload_hash, generated_at,
                                      generated_by)
         VALUES ($1, 1, $2::jsonb, $3, now(), gen_random_uuid())`,
        [certifiedPeriod.rows[0]!.id, JSON.stringify({ secret: 'february figures' }), certifiedHash],
      );

      // (c) another issuer, with an unpublished and a published period
      const rivalId = '99999999-9999-9999-9999-999999999999';
      await testPool().query(
        `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
         VALUES ($1, 'Rival Trust Co', 'NYDFS', 'env-rival') ON CONFLICT (id) DO NOTHING`,
        [rivalId],
      );
      const rivalHidden = 'c'.repeat(64);
      const rivalOpen = 'd'.repeat(64);
      /** The v1 report shape `buildPublicDisclosure` reads, with a marker string. */
      const rivalPayload = (marker: string) => ({
        schema: 'reserveos.report/v1',
        issuer: { id: rivalId, legalName: 'Rival Trust Co', regulator: 'NYDFS' },
        period: { start: '2026-02-01', end: '2026-02-28', asOf: '2026-02-28T23:59:59.999Z' },
        generatedAt: '2026-03-02T00:00:00.000Z',
        reserves: {
          totalMarketValueUsd: '1.00',
          fxSource: marker,
          composition: [],
          custodyByJurisdiction: [],
        },
        outstanding: { totalUsd: '1.00', byChain: [] },
        collateralization: { ratio: '1.0000', ratioPercent: '100.00' },
        lineage: { contributingFactIds: [marker] },
      });
      for (const [status, payloadHash, end] of [
        ['OPEN', rivalHidden, '2026-03-31'],
        ['PUBLISHED', rivalOpen, '2026-02-28'],
      ] as const) {
        const period = await testPool().query<{ id: string }>(
          `INSERT INTO reporting_periods (issuer_id, period_start, period_end, status)
           VALUES ($1, '2026-02-01', $2, $3::period_status) RETURNING id`,
          [rivalId, end, status],
        );
        await testPool().query(
          `INSERT INTO report_versions (period_id, version, payload, payload_hash, generated_at,
                                        generated_by)
           VALUES ($1, 1, $2::jsonb, $3, now(), gen_random_uuid())`,
          [period.rows[0]!.id, JSON.stringify(rivalPayload('rival-secret')), payloadHash],
        );
      }

      // (d) anchors over a daily rollup and an approval. Their merkle roots are
      //     64 hex characters and look exactly like a report hash.
      const rollupRoot = 'e'.repeat(64);
      const approvalRoot = 'f'.repeat(64);
      await testPool().query(
        `INSERT INTO anchors (issuer_id, subject_type, subject_id, merkle_root, status)
         VALUES ($1, 'DAILY_ROLLUP', gen_random_uuid(), $2, 'CONFIRMED'),
                ($1, 'APPROVAL',     gen_random_uuid(), $3, 'CONFIRMED')`,
        [SEED_IDS.issuerId, rollupRoot, approvalRoot],
      );

      const neverExisted = await app.inject({ method: 'GET', url: `/verify/${'9'.repeat(64)}` });
      expect(neverExisted.statusCode).toBe(404);
      const baseline = refusal(neverExisted.body);

      for (const [label, probe] of [
        ['draft report version', draft.hash],
        ['certified but unpublished', certifiedHash],
        ["another tenant's open period", rivalHidden],
        ['daily rollup anchor root', rollupRoot],
        ['approval anchor root', approvalRoot],
      ] as const) {
        const response = await app.inject({ method: 'GET', url: `/verify/${probe}` });
        expect(response.statusCode, label).toBe(404);
        // Byte-identical to a hash that was never issued, so the refusal itself
        // says nothing about whether a period exists.
        expect(refusal(response.body), label).toBe(baseline);
        expect(response.headers['cache-control'], label).toBeUndefined();
        expect(response.body.toLowerCase(), label).not.toContain('rival');
        expect(response.body.toLowerCase(), label).not.toContain('february');
      }

      // Another tenant's PUBLISHED report does resolve, and must: publication is
      // public. What it must not do is carry anything the policies withhold.
      const rivalPublished = await app.inject({ method: 'GET', url: `/verify/${rivalOpen}` });
      expect(rivalPublished.statusCode, rivalPublished.body).toBe(200);
      // Withheld even for a report that is legitimately public: the issuer's
      // Kaleido environment is not a column `reserveos_public` can read, and the
      // disclosure drops lineage and the FX source along with everything else
      // `buildPublicDisclosure` does not copy forward.
      expect(rivalPublished.body).not.toContain('env-rival');
      expect(rivalPublished.body).not.toContain('rival-secret');
      expect(rivalPublished.body).not.toContain('lineage');
    });

    it('resolves nothing through case folding, padding or a truncated hash', async () => {
      const { hash } = await publish();
      // Uppercase is folded and resolves, which is the documented behaviour.
      expect(
        (await app.inject({ method: 'GET', url: `/verify/${hash.toUpperCase()}` })).statusCode,
      ).toBe(200);
      for (const probe of [`${hash}0`, hash.slice(0, 63), `${hash}%20`, `${hash}'`, `${hash}%00`]) {
        const response = await app.inject({ method: 'GET', url: `/verify/${probe}` });
        expect([400, 404], probe).toContain(response.statusCode);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. howToVerify, followed literally
  // -------------------------------------------------------------------------

  describe('howToVerify is executable as written', () => {
    it('every printed step can be carried out and establishes what it claims', async () => {
      const { hash } = await publish();
      const response = await fetchVerification(hash);
      const steps = response.howToVerify as string[];

      // Step: the hash the examiner brought.
      expect(response.certifiedReportHash).toBe(hash);

      // Step: canonicalize `disclosure` per the stated rules and SHA-256 it,
      // here with an independent hash implementation. The printed
      // `canonicalJson` must be the exact string that was hashed.
      const canonical = serverCanonicalize(response.disclosure as CanonicalValue);
      expect(canonical).toBe(response.canonicalJson);
      expect(sha256(canonical)).toBe(response.disclosureHash);
      expect(steps.find((s) => s.includes('RFC 8785'))).toBeDefined();
      // "no insignificant whitespace": re-canonicalizing the parsed form is a
      // fixed point, which it would not be if the string carried any.
      expect(serverCanonicalize(JSON.parse(canonical) as CanonicalValue)).toBe(canonical);
      // "no JSON numbers - quantities are decimal strings": asserted of the
      // document, not by pattern-matching the serialization, where a timestamp
      // inside a string puts digits right after a colon.
      const numbersFound: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (typeof node === 'number') numbersFound.push(path);
        else if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`));
        else if (node !== null && typeof node === 'object') {
          for (const [key, item] of Object.entries(node)) walk(item, `${path}.${key}`);
        }
      };
      walk(response.disclosure, 'disclosure');
      expect(numbersFound).toEqual([]);
      expect(response.disclosure.reserves.totalMarketValueUsd).toMatch(/^-?\d+\.\d{2}$/);

      // Step: the disclosure names its certified report.
      expect(response.disclosure.certifiedReportHash).toBe(response.certifiedReportHash);

      // Step: the commitment, over raw digest bytes rather than hex text.
      const joined = Buffer.concat([
        Buffer.from(response.certifiedReportHash, 'hex'),
        Buffer.from(response.disclosureHash, 'hex'),
      ]);
      expect(createHash('sha256').update(joined).digest('hex')).toBe(response.commitment.expected);
      expect(response.commitment.construction).toMatch(/concatenated raw bytes/);

      // Step: the anchor matches and was accepted.
      expect(response.anchor.merkleRoot).toBe(response.commitment.expected);
      expect(response.anchor.status).toBe('CONFIRMED');
      expect(response.anchor.transactionHash).not.toBeNull();

      // The last step deliberately leaves the system and cannot be run here.
      expect(steps.at(-1)).toMatch(/yourself/i);
      expect(steps.at(-1)).toMatch(/Nothing in this response is evidence/i);
    });

    it('every step names a field that is actually present in the response', async () => {
      const { hash } = await publish();
      const response = await fetchVerification(hash);
      const resolve = (path: string): unknown =>
        path.split('.').reduce<any>((node, key) => (node == null ? node : node[key]), response);

      // Backticked dotted paths in the instructions, minus the ones that name a
      // function rather than a field.
      const referenced = new Set(
        [...(response.howToVerify as string[]).join('\n').matchAll(/`([A-Za-z][\w.]*)`/g)].map(
          (m) => m[1]!,
        ),
      );
      for (const path of referenced) {
        if (['sha256', 'hexToBytes', 'CONFIRMED', 'RFC'].includes(path.split('.')[0]!)) continue;
        expect(resolve(path), `howToVerify refers to \`${path}\``).toBeDefined();
      }
      expect(referenced.size).toBeGreaterThan(6);
    });

    it('warns that a PENDING anchor commits nothing, and is right about it', async () => {
      const { hash } = await publish();
      await testPool().query(
        `UPDATE anchors SET status = 'PENDING', besu_tx_hash = NULL, besu_block_number = NULL,
                            anchored_at = NULL
          WHERE subject_type = 'REPORT_VERSION'`,
      );
      const response = await fetchVerification(hash);
      expect((response.howToVerify as string[]).join('\n')).toMatch(
        /PENDING or FAILED anchor commits nothing/,
      );

      // The printed instruction and the browser module must agree, or one of
      // them is lying to the examiner.
      const result = await verifyResponse(response, hash);
      expect(result.allPassed).toBe(false);
      expect(result.independentStep).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4. The unauthenticated canonicalization helper
  // -------------------------------------------------------------------------

  describe('POST /verify/canonicalize under adversarial input', () => {
    async function post(payload: string) {
      return app.inject({
        method: 'POST',
        url: '/verify/canonicalize',
        headers: { 'content-type': 'application/json' },
        payload,
      });
    }

    it('answers for a document containing __proto__, which both canonicalizers accept', async () => {
      // `test/portal/verify-client.test.ts` pins that both implementations emit
      // `{"__proto__":"x","a":"y"}` for this input. The endpoint that exists so a
      // verifier can check our canonicalization against theirs has to be able to
      // canonicalize it too.
      const response = await post('{"__proto__":"x","a":"y"}');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().canonicalJson).toBe('{"__proto__":"x","a":"y"}');
      expect(response.json().sha256).toBe(sha256('{"__proto__":"x","a":"y"}'));

      // And parsing it polluted nothing.
      const pollution = await post('{"__proto__":{"polluted":"yes"},"a":"y"}');
      expect(pollution.statusCode).toBe(200);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    });

    it('reports a malformed body as a client error rather than an internal one', async () => {
      // A 500 here is wrong twice over: the caller is told the server broke when
      // it was the body that was bad, and `toProblem`'s 5xx branch writes an
      // error-level log line, which an unauthenticated client could then drive
      // at will with a single byte.
      for (const body of ['{ not json', '{"a":', ' ', '{"a":1,}', '{"a":undefined}']) {
        const response = await post(body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(response.json().detail, JSON.stringify(body)).not.toMatch(/correlation id/i);
        expect(response.json().detail, JSON.stringify(body)).toMatch(/valid JSON/);
      }
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });

    it('names the offending value for JSON that is legal but not canonicalizable', async () => {
      const response = await post('{"n":1.5}');
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toMatch(/numbers are forbidden/);
      expect(response.json().detail).toMatch(/\bn\b/);
    });

    it('holds the depth guard exactly where it is documented, for arrays and objects', async () => {
      const nest = (depth: number, open: string, close: string) =>
        `${open.repeat(depth)}"x"${close.repeat(depth)}`;

      for (const [open, close] of [
        ['[', ']'],
        ['{"n":', '}'],
      ] as const) {
        const at = await post(nest(100, open, close));
        expect(at.statusCode, `100 deep ${open}`).toBe(200);

        const over = await post(nest(101, open, close));
        expect(over.statusCode, `101 deep ${open}`).toBe(400);
        expect(over.json().detail).toMatch(/nest/i);
        expect(over.json().detail).not.toMatch(/call stack/i);
      }
    });

    it('cannot be made to overflow inside the guard itself', async () => {
      // The guard walks an explicit stack. Fill the body limit with nesting and
      // with breadth at every level, and confirm the engine's stack message
      // never reaches the wire.
      for (const [label, body] of [
        ['deep arrays', `${'['.repeat(200_000)}${']'.repeat(200_000)}`],
        ['deep objects', `${'{"n":'.repeat(80_000)}"x"${'}'.repeat(80_000)}`],
        ['deep and wide at every level', `${'["a",'.repeat(60_000)}"x"${']'.repeat(60_000)}`],
      ] as const) {
        const response = await post(body);
        expect(response.statusCode, label).toBe(400);
        expect(response.json().detail, label).not.toMatch(/call stack|Maximum/i);
      }

      // Shallow but enormous is answered rather than refused: it breaks no rule.
      const wide = Array.from({ length: 40_000 }, (_, i) => `v${i}`);
      const wideResponse = await post(JSON.stringify(wide));
      expect(wideResponse.statusCode).toBe(200);
      expect(wideResponse.json().sha256).toBe(sha256(browserCanonicalize(wide)));

      const long = { s: 'x'.repeat(900_000) };
      const longResponse = await post(JSON.stringify(long));
      expect(longResponse.statusCode).toBe(200);
      expect(longResponse.json().canonicalJson).toBe(browserCanonicalize(long));

      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });

    it('agrees with the browser module byte for byte over the same request bodies', async () => {
      const bodies = [
        '{"b":"2","a":"1"}',
        '{"":"empty key"}',
        '{"\\u007f":"del","\\u0000":"nul","\\u001f":"unit separator"}',
        '{"s":"\\ud800"}',
        '{"\\ud800":"lone surrogate key"}',
        '{"a":"\\u00e9","b":"e\\u0301"}',
        '{"A":"1","a":"2","Z":"3","z":"4","0":"5","_":"6"}',
        '{"s":"line\\nbreak\\ttab\\\\slash\\"quote"}',
        '{"nested":[{"x":["y",null,true,false]}]}',
        '{"__proto__":"x","a":"y"}',
        '{"s":"\\u2028\\u2029"}',
        '[]',
        '[[],{},[{}]]',
      ];
      for (const body of bodies) {
        const response = await post(body);
        expect(response.statusCode, body).toBe(200);
        const parsed = JSON.parse(body) as CanonicalValue;
        expect(response.json().canonicalJson, body).toBe(browserCanonicalize(parsed));
        expect(response.json().sha256, body).toBe(sha256(browserCanonicalize(parsed)));
      }
    });

    it('stays unauthenticated now that it lives in its own plugin scope', async () => {
      // Moving the route into an encapsulated scope must not change the pattern
      // `isPublicRoute` matches on, or a stale bearer token left on a proxy
      // would turn public verification into a 401.
      for (const headers of [
        { 'content-type': 'application/json' },
        { 'content-type': 'application/json', authorization: 'Bearer rsos_expired-token' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/verify/canonicalize',
          headers,
          payload: '{"b":"2","a":"1"}',
        });
        expect(response.statusCode, JSON.stringify(headers)).toBe(200);
        expect(response.json().canonicalJson).toBe('{"a":"1","b":"2"}');
      }

      // And the scoped parser must not have leaked onto the rest of the API:
      // everything else still gets Fastify's prototype-poisoning-safe default.
      const elsewhere = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: { ...bearer(preparer), 'content-type': 'application/json' },
        payload: '{"__proto__":{"x":1},"periodStart":"2026-05-01","periodEnd":"2026-05-31"}',
      });
      expect(elsewhere.statusCode).not.toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The page
  // -------------------------------------------------------------------------

  describe('the examiner page', () => {
    it('renders the reporting period from the hashed disclosure, not the loose block', () => {
      // Printing `data.period` puts an unverified heading directly above a
      // column of verified figures.
      expect(APP_MJS).toMatch(/disclosure\.period/);
      expect(APP_MJS).not.toMatch(/data\.period\.(start|end)/);
    });

    it('passes the examiner hash into the verifier rather than reading it back out', () => {
      expect(APP_MJS).toMatch(/verifyResponse\(\s*data\s*,\s*hash\s*\)/);
      expect(APP_MJS).not.toMatch(/verifyResponse\(\s*data\s*\)/);
      expect(APP_MJS).not.toMatch(/verifyResponse\([^)]*certifiedReportHash/);
    });

    it('reaches no HTML sink from any module the page loads', () => {
      for (const source of [APP_MJS, VERIFY_CLIENT_MJS]) {
        for (const sink of [
          'innerHTML',
          'outerHTML',
          'insertAdjacentHTML',
          'document.write',
          'eval(',
          'new Function',
          'setHTML',
          'srcdoc',
        ]) {
          expect(source).not.toContain(sink);
        }
      }
      // Every value reaching the DOM does so through a text node or
      // textContent, neither of which can introduce markup.
      expect(APP_MJS).toMatch(/createTextNode/);
    });

    it('cannot render a failed run in the shape of a passed one', () => {
      // Colour alone would be indistinguishable to a colour-blind reader, and a
      // shared class would make a failed banner look like a passed one.
      expect(APP_MJS).toMatch(/result\.allPassed \? 'pass' : 'fail'/);
      expect(APP_MJS).toMatch(/check\.passed \? 'PASS' : 'FAIL'/);
      expect(APP_MJS).toMatch(/Verification failed\. Do not rely on these figures\./);
      expect(INDEX_HTML).toMatch(/\.verdict\.pass\s*\{[^}]*--pass/);
      expect(INDEX_HTML).toMatch(/\.verdict\.fail\s*\{[^}]*--fail/);
      // The error path reuses the failure styling, so a verifier that threw
      // never renders as a neutral notice.
      expect(INDEX_HTML).toMatch(/id="error"[^>]*class="verdict fail"/);
      // Results are hidden before every run, so a previous pass cannot linger
      // beside a later failure.
      expect(APP_MJS).toMatch(/output\.hidden = true/);
    });

    it('ships a page with no inline script for the strict policy to have been relaxed for', async () => {
      const page = await app.inject({ method: 'GET', url: '/portal' });
      const csp = page.headers['content-security-policy'] as string;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-/);
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("base-uri 'none'");
      expect(INDEX_HTML).not.toMatch(/<script(?![^>]*\ssrc=)/i);
      expect(INDEX_HTML).not.toMatch(/\son[a-z]+=/i);
      // Framing is denied by header on this route rather than by CSP, so assert
      // the property rather than the mechanism.
      expect(page.headers['x-frame-options']).toBe('DENY');
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Canonicalization drift the generated corpus cannot reach
// ---------------------------------------------------------------------------

describe('canonicalization drift: input classes the generator never produces', () => {
  function agree(value: unknown, label: string): void {
    expect(browserCanonicalize(value as CanonicalValue), label).toBe(
      serverCanonicalize(value as CanonicalValue),
    );
  }

  it('agrees on every C0 control character, individually, as value and as key', () => {
    for (let code = 0; code < 0x20; code++) {
      const char = String.fromCharCode(code);
      agree({ s: char }, `value U+${code.toString(16).padStart(4, '0')}`);
      agree({ [char]: 'v' }, `key U+${code.toString(16).padStart(4, '0')}`);
    }
    // U+007F and the C1 block are escaped by neither: JCS only mandates
    // escaping below U+0020.
    agree({ s: '\u007f', k: '\u0080', j: '\u009f' }, 'DEL and C1');
    expect(browserCanonicalize({ s: '\u007f' })).toBe('{"s":"\u007f"}');
    expect(browserCanonicalize({ s: '\u001f' })).toBe('{"s":"\\u001f"}');
  });

  it('agrees on lone surrogates in every position', () => {
    for (const s of [
      '\ud800',
      '\udfff',
      'a\ud800b',
      '\ud800\ud800',
      '\udc00\ud800',
      '\ud83c\udfaf\ud800',
      '\ud800 ',
    ]) {
      agree({ s }, JSON.stringify(s));
      agree({ [s]: 'v' }, `key ${JSON.stringify(s)}`);
    }
    // Escaped rather than replaced, so the hashed bytes stay pure ASCII and the
    // two runtimes' UTF-8 encoders cannot disagree about them.
    expect(browserCanonicalize({ s: '\ud800' })).toBe('{"s":"\\ud800"}');
    expect(browserCanonicalize({ s: '\ud800' })).not.toContain('\ufffd');
  });

  it('agrees on keys that differ only by case or by Unicode normalization', () => {
    agree({ a: '1', A: '2', b: '3', B: '4' }, 'ASCII case');
    agree({ ss: '1', SS: '2', '\u00df': '3' }, 'case folding would collide these');
    agree({ '\u00e9': 'nfc', 'e\u0301': 'nfd' }, 'NFC vs NFD');
    const angstrom = { 'A\u030a': 'nfd', '\u00c5': 'nfc', '\u212b': 'angstrom sign' };
    agree(angstrom, 'three spellings of one glyph');
    // Neither side normalizes, so all three survive as distinct members and
    // sort by their differing code units.
    expect(Object.keys(JSON.parse(browserCanonicalize(angstrom)))).toHaveLength(3);
    // Sorted by UTF-16 code unit: 'A' (U+0041) before U+00C5 before U+212B.
    const keys = Object.keys(JSON.parse(browserCanonicalize(angstrom)));
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe('A\u030a');
  });

  it('agrees on __proto__ and other prototype-shaped keys, nested and alone', () => {
    for (const source of [
      '{"__proto__":"x"}',
      '{"__proto__":{"__proto__":{"a":"b"}}}',
      '{"constructor":{"prototype":{"polluted":"yes"}}}',
      '{"a":[{"__proto__":"x"}]}',
      '{"__proto__":"x","constructor":"y","prototype":"z","toString":"w"}',
    ]) {
      agree(JSON.parse(source) as CanonicalValue, source);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(browserCanonicalize(JSON.parse('{"__proto__":"x","a":"y"}') as CanonicalValue)).toBe(
      '{"__proto__":"x","a":"y"}',
    );
  });

  it('agrees on objects with a null prototype', () => {
    // Not reachable from JSON.parse, but this module is also called directly on
    // payloads assembled in code.
    const bare = Object.create(null) as Record<string, unknown>;
    bare['b'] = '2';
    bare['a'] = '1';
    agree(bare, 'null-prototype object');
    expect(browserCanonicalize(bare as CanonicalValue)).toBe('{"a":"1","b":"2"}');
    agree({ outer: bare }, 'nested null-prototype object');
  });

  it('agrees on very long strings, including ones that are almost all escapes', () => {
    for (const s of [
      'x'.repeat(1_000_000),
      '"'.repeat(200_000),
      '\\'.repeat(200_000),
      '\n'.repeat(200_000),
      '\ud83c\udfaf'.repeat(100_000),
      '\ud800'.repeat(50_000),
    ]) {
      expect(browserCanonicalize({ s }), `${s.length} chars`).toBe(serverCanonicalize({ s }));
    }
  });

  it('agrees on arrays that are wide, empty or deeply mixed', () => {
    agree(
      Array.from({ length: 50_000 }, (_, i) => `v${i}`),
      'wide array',
    );
    agree([[], [[]], [[[]]], {}, [{}], [[{}]]], 'empty containers');
    agree(
      Array.from({ length: 500 }, () => null),
      'all null',
    );
  });

  it('agrees on nesting either side of every depth an examiner could reach', () => {
    for (const depth of [99, 100, 101, 500, 2000]) {
      let objectValue: CanonicalValue = 'leaf';
      let arrayValue: CanonicalValue = 'leaf';
      for (let i = 0; i < depth; i++) {
        objectValue = { n: objectValue };
        arrayValue = [arrayValue];
      }
      agree(objectValue, `object depth ${depth}`);
      agree(arrayValue, `array depth ${depth}`);
    }
  });
});
