import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from '../db/harness.js';
import {
  bearer,
  createTestServer,
  seedBackedPeriod,
  seedUser,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { isPublicRoute } from '../../src/api/server.js';
import { PgAnchorStore, PgApprovalStore } from '../../src/db/stores/workflow.js';
import { EvidenceService } from '../../src/services/evidence.js';
import { FakeKaleidoClient } from '../../src/kaleido/fake.js';
import {
  APPROVAL_ROLES,
  CertificationError,
  CertificationService,
  InMemoryApprovalStore,
  type ApprovalRole,
} from '../../src/services/certification.js';

/**
 * Completion pass over the interrupted authz review.
 *
 * Everything the previous reviewer claimed to have fixed lives in a route or in
 * `authenticate`; this file attacks the layer underneath each claim. The three
 * fixes were separately mutation-tested by hand (revert, watch a test fail,
 * restore byte-identically); what is committed here is the coverage those
 * reverts did *not* have.
 */

const available = await databaseAvailable();

let server: TestServer;
let app: FastifyInstance;

const PAYLOAD_HASH = 'c'.repeat(64);
const PERIOD_ID = '00000000-0000-4000-8000-0000000000a1';
const VERSION_A = '00000000-0000-4000-8000-0000000000a2';
const VERSION_B = '00000000-0000-4000-8000-0000000000a3';

/** One human, holding every certification role. The threat the chain exists for. */
const SOLO_ACTOR_ID = '00000000-0000-4000-8000-0000000000f1';

async function seedReportVersion(versionId: string, version: number): Promise<void> {
  const pool = testPool();
  await pool.query(
    `INSERT INTO reporting_periods (id, issuer_id, period_start, period_end)
     VALUES ($1, $2, '2026-03-01', '2026-03-31')
     ON CONFLICT (id) DO NOTHING`,
    [PERIOD_ID, SEED_IDS.issuerId],
  );
  await pool.query(
    `INSERT INTO report_versions
       (id, period_id, version, payload, payload_hash, generated_at, generated_by)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6)`,
    [
      versionId,
      PERIOD_ID,
      version,
      String(version).padStart(64, 'd'),
      new Date('2026-04-01T00:00:00.000Z'),
      SEED_IDS.issuerId,
    ],
  );
}

describe.skipIf(!available)('authz review', () => {
  beforeEach(async () => {
    await resetDatabase();
    // Users reference issuers, so they go with everything else.
    await testPool().query('TRUNCATE api_tokens, users CASCADE');
    await seedTenant();
    server ??= await createTestServer();
    app = server.app;
  });

  afterAll(async () => {
    if (server !== undefined) await server.app.close();
  });

  // -------------------------------------------------------------------------
  // Four eyes, below the HTTP route
  // -------------------------------------------------------------------------

  /**
   * The previous reviewer put the four-eyes check in the approvals ROUTE and said
   * so. A guarantee that lives in one HTTP handler holds only for callers who
   * happen to use that handler: the ingestion workers, a future admin path, a
   * back-fill script and the test suite itself all reach `CertificationService`
   * directly. The invariant is a property of the approval chain, not of a URL,
   * so it has to be refused by the service — which is also the only layer both
   * the in-memory and the Postgres store go through.
   */
  describe('four eyes is enforced by CertificationService, not only by the route', () => {
    function build(store: PgApprovalStore | InMemoryApprovalStore): CertificationService {
      const kaleido = new FakeKaleidoClient();
      let counter = 0;
      const newId = (): string =>
        `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;
      return new CertificationService({
        approvals: store,
        kaleido,
        evidence: new EvidenceService({ store: new PgAnchorStore(testPool()), kaleido, newId }),
        sign: async ({ payloadHash }) => `sig(${payloadHash.slice(0, 8)})`,
        newId,
        now: () => new Date('2026-04-02T15:00:00.000Z'),
      });
    }

    /** The same human, presenting whichever role the next stage wants. */
    function solo(role: ApprovalRole) {
      return {
        id: SOLO_ACTOR_ID,
        email: 'solo@acme.test',
        roles: [role],
        stepUpVerified: true,
      };
    }

    function submit(
      service: CertificationService,
      role: ApprovalRole,
      reportVersionId = VERSION_A,
      actorId = SOLO_ACTOR_ID,
    ) {
      return service.submitApproval({
        issuerId: SEED_IDS.issuerId,
        reportVersionId,
        payloadHash: PAYLOAD_HASH,
        actor: { ...solo(role), id: actorId },
        role,
        decision: 'APPROVED',
        hasCriticalBreach: false,
      });
    }

    it('refuses a second decision from an identity that already signed the version', async () => {
      await seedReportVersion(VERSION_A, 1);
      const service = build(new PgApprovalStore(testPool()));

      await submit(service, 'PREPARER');

      await expect(submit(service, 'COMPLIANCE')).rejects.toThrow(CertificationError);
      await expect(submit(service, 'COMPLIANCE')).rejects.toThrow(
        /already recorded a decision .* as PREPARER/i,
      );
    });

    it('never lets one identity walk PREPARER through CEO alone', async () => {
      await seedReportVersion(VERSION_A, 1);
      const approvals = new PgApprovalStore(testPool());
      const service = build(approvals);

      const outcomes: string[] = [];
      for (const role of APPROVAL_ROLES) {
        try {
          const result = await submit(service, role);
          outcomes.push(`${role}: signed certified=${result.certified}`);
        } catch (error) {
          // Only a refusal counts as a refusal. A bare `catch` recorded any
          // throw — a connection drop or a typo in the fixture SQL — as the
          // security control working, which is the one outcome this test exists
          // to distinguish from failure.
          if (!(error instanceof CertificationError)) throw error;
          expect(error.message, `${role} refusal reason`).toMatch(
            /already recorded a decision/i,
          );
          outcomes.push(`${role}: refused`);
        }
      }

      // Exactly one signature, and no certification. Before the fix this read
      // signed/signed/signed/signed and `certified=true` — four statutory
      // signatures, one human, no HTTP route involved.
      expect(outcomes).toEqual([
        'PREPARER: signed certified=false',
        'COMPLIANCE: refused',
        'CFO: refused',
        'CEO: refused',
      ]);
      expect(await approvals.listForVersion(VERSION_A)).toHaveLength(1);
      expect(await service.nextRole(VERSION_A)).toBe('COMPLIANCE');
    });

    it('applies the same refusal to the in-memory store', async () => {
      const service = build(new InMemoryApprovalStore());
      await submit(service, 'PREPARER');
      await expect(submit(service, 'COMPLIANCE')).rejects.toThrow(
        /already recorded a decision/i,
      );
    });

    it('still lets one person sign the same role on a different report version', async () => {
      await seedReportVersion(VERSION_A, 1);
      await seedReportVersion(VERSION_B, 2);
      const service = build(new PgApprovalStore(testPool()));

      await submit(service, 'PREPARER', VERSION_A);
      // Segregation is per version. Refusing this would stop a preparer from ever
      // preparing twice, which is not the invariant.
      //
      // Asserted on the persisted rows, not on the return value: `submit` always
      // resolves to an object, so `toBeDefined()` passed whether or not the
      // signature reached the database.
      const second = await submit(service, 'PREPARER', VERSION_B);
      expect(second.approval.reportVersionId).toBe(VERSION_B);

      const store = new PgApprovalStore(testPool());
      expect(await store.listForVersion(VERSION_A)).toHaveLength(1);
      const onB = await store.listForVersion(VERSION_B);
      expect(onB).toHaveLength(1);
      expect(onB[0]!.role).toBe('PREPARER');
    });

    it('does not refuse four distinct people', async () => {
      await seedReportVersion(VERSION_A, 1);
      const service = build(new PgApprovalStore(testPool()));

      let certified = false;
      for (const [index, role] of APPROVAL_ROLES.entries()) {
        const actorId = `00000000-0000-4000-8000-00000000000${index + 1}`;
        certified = (await submit(service, role, VERSION_A, actorId)).certified;
      }
      expect(certified).toBe(true);
    });

    /**
     * The route check must survive too, and with its own status code: 403 says
     * "you may not", which is what the console renders. The service refusal
     * surfaces as 422 and would be a worse message for this case.
     */
    it('the HTTP route still answers 403 before the service is reached', async () => {
      await seedBackedPeriod();
      const soloUser = await seedUser({
        roles: ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'],
        email: 'solo-http@a.test',
        stepUp: true,
      });
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(soloUser),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const generated = await app.inject({
        method: 'POST',
        url: `/api/periods/${created.json().id}/report`,
        headers: bearer(soloUser),
      });
      const versionId = generated.json().versionId as string;

      const sign = (role: string) =>
        app.inject({
          method: 'POST',
          url: `/api/reports/${versionId}/approvals`,
          headers: bearer(soloUser),
          payload: { role, decision: 'APPROVED' },
        });

      expect((await sign('PREPARER')).statusCode).toBe(201);
      for (const role of ['COMPLIANCE', 'CFO', 'CEO']) {
        const response = await sign(role);
        expect(response.statusCode, role).toBe(403);
        expect(response.json().detail).toMatch(/already signed/i);
      }

      const { rows } = await testPool().query<{ status: string }>(
        `SELECT status FROM reporting_periods WHERE id = $1`,
        [created.json().id],
      );
      expect(rows[0]?.status).not.toBe('CERTIFIED');
    });
  });

  // -------------------------------------------------------------------------
  // The public surface
  // -------------------------------------------------------------------------

  /**
   * `isPublicRoute` keys on the pattern Fastify resolved, so the question is
   * whether any request can be made to resolve to a listed pattern while being
   * served by a handler that reads tenant data — and whether the omission of a
   * route from the list is fail-safe.
   */
  describe('PUBLIC_ROUTES', () => {
    const unusable = { authorization: 'Bearer rsos_this-token-does-not-exist' };

    it('cannot be reached by a traversal-shaped path onto an authenticated handler', async () => {
      const shapes = [
        '/portal/../api/me',
        '/portal/%2e%2e/api/me',
        '/portal/..%2fapi%2fme',
        '/verify/../api/me',
        '/verify/canonicalize/../../api/me',
        '/operator/../api/me',
        '/operator/app.mjs/../../api/me',
        '/health/../api/me',
        '/api%2fme',
      ];
      for (const url of shapes) {
        const response = await app.inject({ method: 'GET', url, headers: unusable });
        // 401, never 200: whether the path 404s or normalizes onto /api/me, the
        // pattern that decides publicness is the one Fastify actually matched.
        expect(response.statusCode, url).toBe(401);
      }
    });

    it('does not treat a near-miss on a public path as public', async () => {
      // Case, trailing slash and doubled separator all miss the registered
      // pattern, so they get no exemption — they 401 rather than 200.
      for (const url of ['/HEALTH', '/health/', '//health', '/Portal', '/operator/ui.d.mts']) {
        const response = await app.inject({ method: 'GET', url, headers: unusable });
        expect(response.statusCode, url).toBe(401);
      }
    });

    it('fails safe for any route pattern nobody remembered to list', async () => {
      // The property the comment in server.ts claims, asserted directly: an
      // unlisted pattern is not public, so a new route added without touching
      // PUBLIC_ROUTES keeps demanding a valid token.
      for (const pattern of [
        '/api/me',
        '/api/reports/:id/approvals',
        '/api/periods/:id/publish',
        '/portal/verify-client.d.mts',
        '/operator/secrets.mjs',
        '/some/route/added/next/quarter',
        undefined,
      ]) {
        expect(
          isPublicRoute({ routeOptions: { url: pattern } } as unknown as FastifyRequest),
          String(pattern),
        ).toBe(false);
      }
    });

    it('exempts only patterns that serve no tenant data', async () => {
      // Each listed pattern, reached with a credential that cannot be resolved.
      const publicGets: readonly [string, number][] = [
        ['/health', 200],
        ['/portal', 200],
        ['/portal/app.mjs', 200],
        ['/portal/verify-client.mjs', 200],
        ['/operator', 200],
        ['/operator/app.mjs', 200],
        ['/operator/api.mjs', 200],
        ['/operator/ui.mjs', 200],
        // Reached the handler (404 from the query), rather than refused at the door.
        [`/verify/${'a'.repeat(64)}`, 404],
      ];
      for (const [url, status] of publicGets) {
        const response = await app.inject({ method: 'GET', url, headers: unusable });
        expect(response.statusCode, url).toBe(status);
      }

      // The static bodies must carry no tenant material of their own.
      await seedBackedPeriod();
      for (const url of ['/portal', '/operator', '/operator/app.mjs', '/operator/api.mjs']) {
        const body = (await app.inject({ method: 'GET', url, headers: unusable })).body;
        expect(body, url).not.toContain(SEED_IDS.issuerId);
        expect(body, url).not.toContain('Acme Digital Trust');
      }
    });

    it('keeps every authenticated route behind a usable credential', async () => {
      const authenticated: readonly ['GET' | 'POST', string][] = [
        ['GET', '/api/me'],
        ['GET', '/api/custodians'],
        ['GET', '/api/deployments'],
        ['GET', '/api/documents'],
        ['GET', '/api/redemptions/open'],
        ['GET', '/api/periods'],
        ['POST', '/api/periods'],
        ['GET', `/api/periods/${PERIOD_ID}`],
        ['GET', `/api/periods/${PERIOD_ID}/computation`],
        ['POST', `/api/periods/${PERIOD_ID}/report`],
        ['POST', `/api/periods/${PERIOD_ID}/publish`],
        ['GET', `/api/reports/${VERSION_A}`],
        ['GET', `/api/reports/${VERSION_A}/approvals`],
        ['POST', `/api/reports/${VERSION_A}/approvals`],
        ['POST', '/api/auth/step-up'],
      ];
      for (const [method, url] of authenticated) {
        const stale = await app.inject({ method, url, headers: unusable, payload: {} });
        expect(stale.statusCode, `${method} ${url} (stale token)`).toBe(401);

        const anonymous = await app.inject({ method, url, payload: {} });
        expect(anonymous.statusCode, `${method} ${url} (no token)`).toBe(401);
      }
    });
  });

  /**
   * The other half of "an anonymous caller should not be answered with a 400".
   *
   * Moving `requirePrincipal` ahead of `parseBody` fixed the case where the body
   * parses. It does not reach the case where it does not: Fastify rejects an
   * unparseable body during the parsing phase, before the `preHandler` that
   * authenticates and before the handler exists to be reordered. Those
   * rejections arrived at `setErrorHandler` as plain FastifyErrors, and
   * `toProblem` maps anything that is not an `ApiError` to 500 — so every
   * authenticated POST route answered an unauthenticated malformed byte with
   * "Internal Server Error" *and* an error-level log line with a stack.
   *
   * `routes/verify.ts` documents this exact failure and fixed it for
   * `/verify/canonicalize` alone, with a parser private to that scope. Every
   * other POST route still had it.
   */
  describe('a body Fastify refuses is the caller error it is', () => {
    const POST_ROUTES = [
      '/api/periods',
      '/api/auth/step-up',
      `/api/reports/${VERSION_A}/approvals`,
      `/api/periods/${PERIOD_ID}/report`,
      `/api/periods/${PERIOD_ID}/publish`,
    ] as const;

    it('answers malformed JSON with 400 rather than 500, on every POST route', async () => {
      for (const url of POST_ROUTES) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: '{"role": ',
        });
        expect(response.statusCode, url).toBe(400);
        expect(response.json().status, url).toBe(400);
      }
    });

    it('answers a body over the limit with 413 rather than 500', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/reports/${VERSION_A}/approvals`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ role: 'CFO', pad: 'x'.repeat(2_000_000) }),
      });
      // bodyLimit is 1 MiB and exists to reject oversized payloads early; a 500
      // told the caller the rejection was our fault.
      expect(response.statusCode).toBe(413);
    });

    it('still tells an anonymous caller nothing about the approval schema', async () => {
      // The regression guard on the reordering fix: a client error now reaches
      // the caller for a malformed body, and it must still not describe what a
      // well-formed one would look like.
      const response = await app.inject({
        method: 'POST',
        url: `/api/reports/${VERSION_A}/approvals`,
        headers: { 'content-type': 'application/json' },
        payload: '{"role": ',
      });
      const detail = response.json().detail as string;
      for (const leak of ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO', 'APPROVED', 'decision']) {
        expect(detail, leak).not.toContain(leak);
      }
      // And nothing about this process either.
      expect(response.body).not.toMatch(/\bat .*\.(ts|js):\d+/);
      expect(response.body).not.toContain('node_modules');
    });

    it('leaves a genuine server fault opaque', async () => {
      // The narrowness of the translation, driven through the server rather than
      // asserted about a helper. An approval stored without a Policy Manager
      // decision id makes `toApprovalRecord` throw on read — a real internal
      // fault, carrying no FST_ERR_ code — and it must still collapse to the
      // blind 500 body rather than describing the schema that broke.
      await seedReportVersion(VERSION_A, 1);
      await testPool().query(
        `INSERT INTO approvals
           (report_version_id, role, actor_id, actor_email, decision,
            attestation_text, signature, pms_decision_id)
         VALUES ($1, 'PREPARER', $2, 'p@a.test', 'APPROVED', 'text', 'sig', NULL)`,
        [VERSION_A, SOLO_ACTOR_ID],
      );
      const reader = await seedUser({ roles: ['VIEWER'], email: 'opaque@a.test' });

      const response = await app.inject({
        method: 'GET',
        url: `/api/reports/${VERSION_A}/approvals`,
        headers: bearer(reader),
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().title).toBe('Internal Server Error');
      expect(response.body).not.toContain('pms_decision_id');
      expect(response.body).not.toMatch(/\bat .*\.(ts|js):\d+/);
    });
  });

  // -------------------------------------------------------------------------
  // What a step-up actually buys
  // -------------------------------------------------------------------------

  /**
   * The step-up is a five-minute reusable window on a credential the caller
   * already holds, not a per-signature assertion. This test states the blast
   * radius in the terms that matter: how many statutory signatures one WebAuthn
   * ceremony can produce. It is a characterization test — if the design changes
   * to one-shot consumption, this must be rewritten deliberately.
   */
  describe('step-up window', () => {
    it('lets one step-up cover certifications on two different report versions', async () => {
      await seedBackedPeriod();
      const preparer = await seedUser({ roles: ['PREPARER'], email: 'p-two@a.test' });
      const compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'c-two@a.test' });
      const cfo = await seedUser({ roles: ['CFO'], email: 'cfo-two@a.test' });
      const ceo = await seedUser({ roles: ['CEO'], email: 'ceo-two@a.test', stepUp: true });

      // Exactly one step-up ceremony for the CFO, at the frozen clock.
      const recorded = await app.inject({
        method: 'POST',
        url: '/api/auth/step-up',
        headers: bearer(cfo),
      });
      expect(recorded.statusCode).toBe(200);
      expect(recorded.json().validForSeconds).toBe(300);

      async function versionFor(start: string, end: string): Promise<string> {
        const created = await app.inject({
          method: 'POST',
          url: '/api/periods',
          headers: bearer(preparer),
          payload: { periodStart: start, periodEnd: end },
        });
        expect(created.statusCode, created.body).toBe(201);
        const generated = await app.inject({
          method: 'POST',
          url: `/api/periods/${created.json().id}/report`,
          headers: bearer(preparer),
        });
        expect(generated.statusCode, generated.body).toBe(201);
        return generated.json().versionId as string;
      }

      function sign(user: TestUser, versionId: string, role: string) {
        return app.inject({
          method: 'POST',
          url: `/api/reports/${versionId}/approvals`,
          headers: bearer(user),
          payload: { role, decision: 'APPROVED' },
        });
      }

      const march = await versionFor('2026-03-01', '2026-03-31');
      const april = await versionFor('2026-04-01', '2026-04-30');

      for (const versionId of [march, april]) {
        expect((await sign(preparer, versionId, 'PREPARER')).statusCode).toBe(201);
        expect((await sign(compliance, versionId, 'COMPLIANCE')).statusCode).toBe(201);
        const cfoSignature = await sign(cfo, versionId, 'CFO');
        expect(cfoSignature.statusCode, cfoSignature.body).toBe(201);
        expect((await sign(ceo, versionId, 'CEO')).json().certified).toBe(true);
      }

      // Two statutory CFO certifications, on two distinct reports, from a single
      // proof of presence. Recorded so that the reach of one ceremony is a stated
      // property rather than a discovery.
      const { rows } = await testPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM approvals WHERE actor_id = $1 AND role = 'CFO'`,
        [cfo.userId],
      );
      expect(rows[0]?.n).toBe(2);
    });
  });
});
