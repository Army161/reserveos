import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from '../db/harness.js';
import {
  bearer,
  createTestServer,
  seedBackedPeriod,
  seedOtherIssuer,
  seedUser,

  type TestServer,
  type TestUser,
} from './helpers.js';

const available = await databaseAvailable();

let server: TestServer;
let app: FastifyInstance;

describe.skipIf(!available)('HTTP API', () => {
  let preparer: TestUser;

  beforeEach(async () => {
    await resetDatabase();
    // Users reference issuers, so they are wiped with everything else.
    await testPool().query('TRUNCATE api_tokens, users CASCADE');
    await seedTenant();
    server ??= await createTestServer();
    app = server.app;
    preparer = await seedUser({ roles: ['PREPARER'] });
  });

  afterAll(async () => {
    if (server !== undefined) await server.app.close();
  });

  describe('authentication', () => {
    it('rejects an unauthenticated request', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/me' });
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('rejects a malformed token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a revoked token', async () => {
      const revoked = await seedUser({ roles: ['PREPARER'], email: 'r@a.test', revoked: true });
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(revoked),
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an expired token', async () => {
      const expired = await seedUser({
        roles: ['PREPARER'],
        email: 'e@a.test',
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(expired),
      });
      expect(response.statusCode).toBe(401);
    });

    it('accepts a valid token and reports the principal', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user.roles).toEqual(['PREPARER']);
      expect(body.issuer.id).toBe(SEED_IDS.issuerId);
    });

    it('never returns the token or its hash', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(preparer),
      });
      expect(response.body).not.toContain(preparer.token);
      expect(response.body).not.toContain('token_hash');
    });
  });

  describe('authorization', () => {
    it('refuses an action the role does not permit', async () => {
      const viewer = await seedUser({ roles: ['VIEWER'], email: 'v@a.test' });
      const response = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(viewer),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('allows a preparer to open a period', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(preparer),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe('OPEN');
    });
  });

  describe('input validation', () => {
    it('rejects a malformed date and names the field', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(preparer),
        payload: { periodStart: '01/03/2026', periodEnd: '2026-03-31' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().detail).toContain('periodStart');
    });

    it('rejects a period that ends before it starts', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(preparer),
        payload: { periodStart: '2026-03-31', periodEnd: '2026-03-01' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a non-UUID path parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/periods/not-a-uuid',
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('hides another issuer period behind a 404', async () => {
      const other = await seedOtherIssuer();
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(other.user),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      expect(created.statusCode).toBe(201);
      const otherPeriodId = created.json().id;

      // A valid, well-formed id belonging to someone else. "Not found" rather
      // than "forbidden": confirming existence would itself leak.
      const response = await app.inject({
        method: 'GET',
        url: `/api/periods/${otherPeriodId}`,
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(404);
    });

    it('lists only the caller own periods', async () => {
      const other = await seedOtherIssuer();
      await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(other.user),
        payload: { periodStart: '2026-02-01', periodEnd: '2026-02-28' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(preparer),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/periods',
        headers: bearer(preparer),
      });
      const periods = response.json().periods;
      expect(periods).toHaveLength(1);
      expect(periods[0].periodEnd).toBe('2026-03-31');
    });
  });

  /**
   * The dangerous case is not a draft belonging to someone else — that is
   * already covered above — but a PUBLISHED one. `reserveos_app` is a member of
   * `reserveos_public` (migration 006 grants it so the verify endpoint can
   * downgrade itself), and Postgres applies a policy to every role the caller is
   * a member of. The permissive `*_published` policies therefore OR with the
   * tenant policies for ordinary authenticated traffic, and every RLS check on
   * a published row degrades to "or it is published anywhere".
   *
   * So the handlers must scope by issuer themselves rather than trusting RLS.
   */
  describe('tenant isolation for published records', () => {
    async function rivalPublishedReport(): Promise<{
      periodId: string;
      versionId: string;
    }> {
      const other = await seedOtherIssuer();
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(other.user),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      expect(created.statusCode).toBe(201);
      const periodId = created.json().id;

      const generated = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/report`,
        headers: bearer(other.user),
      });
      expect(generated.statusCode).toBe(201);

      // Publication normally requires a full certification chain; the state is
      // what matters here, so set it directly as the owner.
      await testPool().query(`UPDATE reporting_periods SET status = 'PUBLISHED' WHERE id = $1`, [
        periodId,
      ]);

      return { periodId, versionId: generated.json().versionId };
    }

    it('hides another issuer published period', async () => {
      const rival = await rivalPublishedReport();
      const response = await app.inject({
        method: 'GET',
        url: `/api/periods/${rival.periodId}`,
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('2026-03-31');
    });

    it('hides another issuer published report payload', async () => {
      const rival = await rivalPublishedReport();
      const response = await app.inject({
        method: 'GET',
        url: `/api/reports/${rival.versionId}`,
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(404);
      // The full report names the issuer and carries fact-level lineage.
      expect(response.body).not.toContain('Rival Trust Co');
      expect(response.body).not.toContain('contributingFactIds');
    });

    it('hides another issuer published period from the computation view', async () => {
      const rival = await rivalPublishedReport();
      const response = await app.inject({
        method: 'GET',
        url: `/api/periods/${rival.periodId}/computation`,
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses to republish another issuer published period', async () => {
      const rival = await rivalPublishedReport();
      const compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'c@a.test' });
      const response = await app.inject({
        method: 'POST',
        url: `/api/periods/${rival.periodId}/publish`,
        headers: bearer(compliance),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('response surface', () => {
    it('never returns custodian connector configuration', async () => {
      await testPool().query(
        `UPDATE custodians SET connector_config = '{"password_ref":"vault://bny/prod"}'`,
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/custodians',
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('vault://bny/prod');
      expect(response.body).not.toContain('connectorConfig');
    });

    it('never returns the issuer kaleido environment or rule configuration', async () => {
      await testPool().query(`UPDATE issuers SET rule_config = '{"maxTenorDays":42}' WHERE id = $1`, [
        SEED_IDS.issuerId,
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('env-test');
      expect(response.body).not.toContain('maxTenorDays');
      expect(response.body).not.toContain('kaleido');
    });

    it('never returns the kaleido connector id of a deployment', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/deployments',
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('conn-eth');
      expect(response.body).not.toContain('kaleido');
    });
  });

  describe('computation view', () => {
    it('serializes money as strings so the browser cannot round it', async () => {
      await seedBackedPeriod();
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(preparer),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const periodId = created.json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/periods/${periodId}/computation`,
        headers: bearer(preparer),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.totalReserveValueUsd).toBe('10500000.00');
      expect(body.totalOutstandingUsd).toBe('10000000.00');
      expect(body.collateralizationRatio).toBe('1.0500');
      expect(typeof body.totalReserveValueUsd).toBe('string');
      // A uint256-scale supply must survive as an exact decimal string.
      expect(typeof body.outstandingByChain[0].totalSupplyRaw).toBe('string');
      expect(body.breaches).toEqual([]);
    });
  });

  /**
   * Authentication and authorization, attacked directly.
   *
   * The controls under test are the only thing between a leaked bearer token and
   * a report carrying four statutory signatures, so each one is exercised from
   * the outside over HTTP rather than by calling the helper that implements it.
   */
  describe('authentication and authorization', () => {
    const APP_CLOCK = '2026-04-02T14:30:00.000Z';

    /** A generated, uncertified report version belonging to the seed tenant. */
    async function versionReadyToSign(author: TestUser): Promise<string> {
      await seedBackedPeriod();
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(author),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      expect(created.statusCode).toBe(201);
      const generated = await app.inject({
        method: 'POST',
        url: `/api/periods/${created.json().id}/report`,
        headers: bearer(author),
      });
      expect(generated.statusCode).toBe(201);
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

    async function stampStepUp(user: TestUser, at: Date): Promise<void> {
      await testPool().query(`UPDATE api_tokens SET step_up_at = $2 WHERE id = $1`, [
        user.tokenId,
        at,
      ]);
    }

    async function stepUpVerified(user: TestUser): Promise<boolean> {
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(user) });
      expect(me.statusCode).toBe(200);
      return me.json().user.stepUpVerified as boolean;
    }

    describe('token lifecycle', () => {
      it('rejects a token whose user has been deactivated', async () => {
        const user = await seedUser({ roles: ['PREPARER'], email: 'gone@a.test' });
        await testPool().query(`UPDATE users SET active = FALSE WHERE id = $1`, [user.userId]);

        const response = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: bearer(user),
        });
        expect(response.statusCode).toBe(401);
      });

      it('never echoes the presented token back to the caller', async () => {
        const stolen = 'rsos_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
        const response = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: `Bearer ${stolen}` },
        });
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain(stolen);
        expect(JSON.stringify(response.headers)).not.toContain(stolen);
      });
    });

    /**
     * Step-up freshness.
     *
     * `stepUpVerified` is the sole difference between a live session and proof of
     * presence at the moment of signing, so the window it describes has to be
     * bounded at both ends. `now - stamp < WINDOW` is satisfied by every stamp
     * dated in the future, which is not a hypothetical shape: the stamp is
     * written by one clock and read by another.
     */
    describe('step-up freshness', () => {
      it('does not accept a step-up stamp dated in the future', async () => {
        const cfo = await seedUser({ roles: ['CFO'], email: 'ahead@a.test' });
        // An hour ahead of the clock that judges it — the shape produced by a
        // database host running fast, and by a stamp written with SQL now()
        // while freshness is measured against the API host.
        await stampStepUp(cfo, new Date('2026-04-02T15:30:00.000Z'));

        expect(await stepUpVerified(cfo)).toBe(false);
      });

      it('does not accept a step-up stamp dated far in the future', async () => {
        const cfo = await seedUser({ roles: ['CFO'], email: 'nextyear@a.test' });
        await stampStepUp(cfo, new Date('2027-04-02T14:30:00.000Z'));

        // An unbounded-above window never closes: this stamp would still be
        // "fresh" a year from now.
        expect(await stepUpVerified(cfo)).toBe(false);
      });

      it('refuses an executive signature backed by a future-dated step-up', async () => {
        const compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'c1@a.test' });
        const cfo = await seedUser({ roles: ['CFO'], email: 'c2@a.test' });
        await stampStepUp(cfo, new Date('2027-04-02T14:30:00.000Z'));

        const versionId = await versionReadyToSign(preparer);
        expect((await sign(preparer, versionId, 'PREPARER')).statusCode).toBe(201);
        expect((await sign(compliance, versionId, 'COMPLIANCE')).statusCode).toBe(201);

        const response = await sign(cfo, versionId, 'CFO');
        expect(response.statusCode).toBe(422);
        expect(response.json().detail).toMatch(/step-up/i);
      });

      it('lets a step-up expire once the window has passed', async () => {
        const cfo = await seedUser({ roles: ['CFO'], email: 'stale@a.test' });
        await stampStepUp(cfo, new Date('2026-04-02T14:24:00.000Z')); // six minutes old

        expect(await stepUpVerified(cfo)).toBe(false);
      });

      it('stamps a step-up on the same clock that later judges its freshness', async () => {
        const cfo = await seedUser({ roles: ['CFO'], email: 'live@a.test' });
        expect(await stepUpVerified(cfo)).toBe(false);

        const recorded = await app.inject({
          method: 'POST',
          url: '/api/auth/step-up',
          headers: bearer(cfo),
        });
        expect(recorded.statusCode).toBe(200);

        // Not merely "verified now" — verified because the stamp was written by
        // the clock `authenticate` compares against. Stamping with SQL now()
        // instead makes the window as long as the skew between the two hosts.
        const { rows } = await testPool().query<{ step_up_at: Date }>(
          `SELECT step_up_at FROM api_tokens WHERE id = $1`,
          [cfo.tokenId],
        );
        expect(rows[0]?.step_up_at.toISOString()).toBe(APP_CLOCK);
        expect(await stepUpVerified(cfo)).toBe(true);
      });

      /**
       * Deliberate: a step-up is a window, not a one-shot token.
       *
       * Consuming it per signature would be stronger, but the freshness bound is
       * what the design leans on, and with the window closed at both ends the
       * reusable interval is five minutes on a credential the caller already
       * holds. Recorded here so that changing it is a decision rather than an
       * accident.
       */
      it('does not consume a step-up, within its window', async () => {
        const cfo = await seedUser({ roles: ['CFO'], email: 'reuse@a.test', stepUp: true });
        expect(await stepUpVerified(cfo)).toBe(true);
        expect(await stepUpVerified(cfo)).toBe(true);
      });
    });

    /**
     * Four eyes.
     *
     * The PREPARER → COMPLIANCE → CFO → CEO chain is only worth the ceremony if
     * the four signatures come from four people. The stage check asks which role
     * signed last and nothing about who.
     */
    describe('segregation of duties', () => {
      it('refuses a second role from the same signer on one report version', async () => {
        const solo = await seedUser({
          roles: ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO'],
          email: 'solo@a.test',
          stepUp: true,
        });
        const versionId = await versionReadyToSign(solo);

        expect((await sign(solo, versionId, 'PREPARER')).statusCode).toBe(201);

        const second = await sign(solo, versionId, 'COMPLIANCE');
        expect(second.statusCode).toBe(403);
        expect(second.json().detail).toMatch(/already signed/i);

        // And the chain has not advanced past the one legitimate signature.
        const listed = await app.inject({
          method: 'GET',
          url: `/api/reports/${versionId}/approvals`,
          headers: bearer(solo),
        });
        expect(listed.json().approvals).toHaveLength(1);
        expect(listed.json().nextRole).toBe('COMPLIANCE');
      });

      it('certifies when the four roles are held by four people', async () => {
        const compliance = await seedUser({ roles: ['COMPLIANCE'], email: 'four1@a.test' });
        const cfo = await seedUser({ roles: ['CFO'], email: 'four2@a.test', stepUp: true });
        const ceo = await seedUser({ roles: ['CEO'], email: 'four3@a.test', stepUp: true });
        const versionId = await versionReadyToSign(preparer);

        expect((await sign(preparer, versionId, 'PREPARER')).statusCode).toBe(201);
        expect((await sign(compliance, versionId, 'COMPLIANCE')).statusCode).toBe(201);
        expect((await sign(cfo, versionId, 'CFO')).statusCode).toBe(201);

        const final = await sign(ceo, versionId, 'CEO');
        expect(final.statusCode, final.body).toBe(201);
        expect(final.json().certified).toBe(true);
      });
    });

    /**
     * `requireRole` folds ADMIN into every allowed set. That is fine for opening
     * a period; it must not reach a signature or the publication gate.
     */
    describe('the ADMIN escape hatch', () => {
      it('does not let an ADMIN sign a certification role it does not hold', async () => {
        const admin = await seedUser({ roles: ['ADMIN'], email: 'admin@a.test', stepUp: true });
        const versionId = await versionReadyToSign(preparer);

        for (const role of ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO']) {
          const response = await sign(admin, versionId, role);
          expect(response.statusCode, role).toBe(403);
          expect(response.json().detail).toMatch(new RegExp(`do not hold the ${role} role`));
        }
      });

      it('does not let an ADMIN publish a period the signers have not certified', async () => {
        const admin = await seedUser({ roles: ['ADMIN'], email: 'admin2@a.test' });
        const created = await app.inject({
          method: 'POST',
          url: '/api/periods',
          headers: bearer(admin),
          payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
        });

        const response = await app.inject({
          method: 'POST',
          url: `/api/periods/${created.json().id}/publish`,
          headers: bearer(admin),
        });
        expect(response.statusCode).toBe(422);
        expect(response.json().detail).toMatch(/only a CERTIFIED period can be published/);
      });
    });

    /**
     * The public surface must not depend on a credential being valid.
     *
     * The preHandler runs for every route. An unusable token — stale, revoked,
     * left behind on a proxy or an API client — otherwise makes independent
     * verification, the examiner portal and the liveness probe all return 401,
     * which is precisely the guarantee the product sells.
     */
    describe('public routes', () => {
      const unusable = { authorization: 'Bearer rsos_this-token-does-not-exist' };

      it('serves the portal and its source to a caller with an unusable token', async () => {
        for (const url of ['/portal', '/portal/app.mjs', '/portal/verify-client.mjs']) {
          const response = await app.inject({ method: 'GET', url, headers: unusable });
          expect(response.statusCode, url).toBe(200);
        }
      });

      it('answers the verification endpoint despite an unusable token', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/verify/${'a'.repeat(64)}`,
          headers: unusable,
        });
        // 404, not 401: the request reached the handler and the handler found no
        // published report with that hash.
        expect(response.statusCode).toBe(404);
        expect(response.json().detail).toMatch(/No published report/);

        const canonical = await app.inject({
          method: 'POST',
          url: '/verify/canonicalize',
          headers: unusable,
          payload: { b: '2', a: '1' },
        });
        expect(canonical.statusCode).toBe(200);
        expect(canonical.json().canonicalJson).toBe('{"a":"1","b":"2"}');
      });

      it('answers the liveness probe despite an unusable token', async () => {
        const response = await app.inject({ method: 'GET', url: '/health', headers: unusable });
        expect(response.statusCode).toBe(200);
      });

      it('still refuses an unusable token everywhere else', async () => {
        for (const url of ['/api/me', '/api/periods', '/api/custodians']) {
          const response = await app.inject({ method: 'GET', url, headers: unusable });
          expect(response.statusCode, url).toBe(401);
        }
        // An unrouted path is not public, so the credential is still judged.
        const unknown = await app.inject({ method: 'GET', url: '/nope', headers: unusable });
        expect(unknown.statusCode).toBe(401);
      });
    });

    /**
     * A rejection must describe the caller, never the existence of someone
     * else's data.
     */
    describe('error semantics', () => {
      it('cannot tell another tenant report version from one that never existed', async () => {
        const other = await seedOtherIssuer();
        const foreignVersion = await (async () => {
          await seedBackedPeriod();
          const created = await app.inject({
            method: 'POST',
            url: '/api/periods',
            headers: bearer(other.user),
            payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
          });
          const generated = await app.inject({
            method: 'POST',
            url: `/api/periods/${created.json().id}/report`,
            headers: bearer(other.user),
          });
          return generated.json().versionId as string;
        })();

        const cfo = await seedUser({ roles: ['CFO'], email: 'probe@a.test', stepUp: true });
        const foreign = await sign(cfo, foreignVersion, 'CFO');
        const absent = await sign(cfo, '00000000-0000-4000-8000-000000000000', 'CFO');

        expect(foreign.statusCode).toBe(404);
        expect(absent.statusCode).toBe(404);
        expect(foreign.json().title).toBe(absent.json().title);
        expect(foreign.json().type).toBe(absent.json().type);
      });

      it('answers a role the caller lacks before consulting the resource', async () => {
        const viewer = await seedUser({ roles: ['VIEWER'], email: 'nosy@a.test' });
        const response = await sign(viewer, '00000000-0000-4000-8000-000000000000', 'CFO');
        // 403 about the caller, not 404 about a version that does not exist:
        // the answer is identical whether or not the id names anything.
        expect(response.statusCode).toBe(403);
        expect(response.json().detail).toMatch(/do not hold the CFO role/);
      });
    });
  });

  describe('error handling', () => {
    it('returns problem+json with a correlation id', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.title).toBe('Not Found');
      expect(body.correlationId).toBeTruthy();
      expect(response.headers['x-correlation-id']).toBeTruthy();
    });

    it('sets defensive response headers', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
    });
  });
});
