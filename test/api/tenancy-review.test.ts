import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  databaseAvailable,
  resetDatabase,
  seedTenant,
  testPool,
  SEED_IDS,
} from '../db/harness.js';
import { withTenant, withTransaction } from '../../src/db/pool.js';
import {
  bearer,
  createTestServer,
  seedBackedPeriod,
  seedOtherIssuer,
  seedUser,
  type TestServer,
  type TestUser,
} from './helpers.js';

/**
 * Independent tenancy review.
 *
 * Everything here runs against `appPool()` — the unprivileged login role that
 * inherits `reserveos_app` — because the superuser pool bypasses row-level
 * security and would make every assertion below vacuous.
 */

const available = await databaseAvailable();

const RIVAL_ISSUER_ID = '99999999-9999-9999-9999-999999999999';
/** Sentinel wording stored with the rival's signature, to catch a leaked row. */
const RIVAL_ATTESTATION = 'rival-attestation-sentinel';

let server: TestServer;
let app: FastifyInstance;
let db: pg.Pool;

describe.skipIf(!available)('tenancy review', () => {
  /** Tenant A's staff. Every role, so authorization never masks a 404. */
  let alice: TestUser;

  beforeEach(async () => {
    await resetDatabase();
    await testPool().query('TRUNCATE api_tokens, users CASCADE');
    await seedTenant();
    server ??= await createTestServer();
    app = server.app;
    db = server.pool;
    alice = await seedUser({
      roles: ['PREPARER', 'COMPLIANCE', 'CFO', 'CEO', 'VIEWER'],
      email: 'alice@acme.test',
      stepUp: true,
    });
  });

  afterAll(async () => {
    if (server !== undefined) await server.app.close();
  });

  /** A rival tenant with a generated report and a PUBLISHED period. */
  async function rivalPublished(): Promise<{
    issuerId: string;
    user: TestUser;
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
    const periodId = created.json().id as string;

    const generated = await app.inject({
      method: 'POST',
      url: `/api/periods/${periodId}/report`,
      headers: bearer(other.user),
    });
    expect(generated.statusCode).toBe(201);

    // The certification chain is exercised elsewhere; the row state is what
    // these assertions turn on, so it is set directly as the schema owner.
    await testPool().query(`UPDATE reporting_periods SET status = 'PUBLISHED' WHERE id = $1`, [
      periodId,
    ]);

    return {
      issuerId: other.issuerId,
      user: other.user,
      periodId,
      versionId: generated.json().versionId as string,
    };
  }

  // -------------------------------------------------------------------------
  // 1. The claim in src/services/period.ts, verified from scratch
  // -------------------------------------------------------------------------
  /**
   * `requireVersion` carries a comment asserting that RLS lets a published row
   * through for any tenant. These tests check that claim against the database
   * rather than believing the comment, because the whole app-level ownership
   * check exists only if it is true.
   */
  describe('the RLS claim', () => {
    it('applies the reserveos_public policies to reserveos_app, via role membership', async () => {
      const { rows } = await db.query<{ inherits: boolean }>(
        `SELECT pg_has_role(current_user, 'reserveos_public', 'USAGE') AS inherits`,
      );
      // Still true, and still necessary: the API downgrades itself with SET
      // LOCAL ROLE to serve the public endpoint, which requires membership.
      // Membership alone no longer grants reach, because migration 009 gates each
      // published policy on `current_user = 'reserveos_public'` — the role the
      // session is EXECUTING as, which SET ROLE changes and membership does not.
      expect(rows[0]?.inherits).toBe(true);
    });

    it('refuses another tenant PUBLISHED period and version at the database', async () => {
      const rival = await rivalPublished();

      const seen = await withTenant(db, SEED_IDS.issuerId, async (client) => {
        const periods = await client.query<{ id: string; issuer_id: string }>(
          `SELECT id, issuer_id FROM reporting_periods WHERE id = $1`,
          [rival.periodId],
        );
        const versions = await client.query<{ id: string }>(
          `SELECT id FROM report_versions WHERE id = $1`,
          [rival.versionId],
        );
        return { periods: periods.rows, versions: versions.rows };
      });

      // This test used to assert the opposite, documenting a real leak: the
      // `*_published` policies were granted TO reserveos_public, Postgres matches
      // policy roles by MEMBERSHIP, and reserveos_app is a member so it could
      // reach SET ROLE — so the published policy OR'd itself onto every
      // authenticated session. Migration 009 added `current_user =
      // 'reserveos_public'`, which membership does not satisfy. The application
      // guard in services/period.ts stays as the second layer.
      expect(seen.periods).toEqual([]);
      expect(seen.versions).toEqual([]);
    });

    it('still fails closed for tables with no published policy', async () => {
      await seedBackedPeriod();
      // `source_documents` was previously asserted to be invisible without ever
      // inserting one, so the zero came from an empty table rather than from a
      // policy. Give the read something it would have to filter out.
      await testPool().query(
        `INSERT INTO source_documents
           (issuer_id, custodian_id, filename, content_hash, byte_size, status, ingested_at)
         VALUES ($1, $2, 'bny-2026-03-31.csv', $3, 1024, 'INGESTED', now())`,
        [SEED_IDS.issuerId, SEED_IDS.bny, 'e'.repeat(64)],
      );

      // Non-vacuity: every table below holds at least one row for tenant A, so a
      // policy that failed open would show up as a non-zero count.
      const present = await testPool().query<{ facts: number; docs: number; supply: number }>(
        `SELECT (SELECT count(*) FROM reserve_facts)::int    AS facts,
                (SELECT count(*) FROM source_documents)::int AS docs,
                (SELECT count(*) FROM supply_facts)::int     AS supply`,
      );
      expect(present.rows[0]?.facts).toBeGreaterThan(0);
      expect(present.rows[0]?.docs).toBeGreaterThan(0);
      expect(present.rows[0]?.supply).toBeGreaterThan(0);

      const seen = await withTenant(db, RIVAL_ISSUER_ID, async (client) => {
        const facts = await client.query(`SELECT id FROM reserve_facts`);
        const custodians = await client.query(`SELECT id FROM custodians`);
        const documents = await client.query(`SELECT id FROM source_documents`);
        const supply = await client.query(`SELECT id FROM supply_facts`);
        return {
          facts: facts.rowCount,
          custodians: custodians.rowCount,
          documents: documents.rowCount,
          supply: supply.rowCount,
        };
      });

      expect(seen).toEqual({ facts: 0, custodians: 0, documents: 0, supply: 0 });
    });

    /**
     * An unscoped transaction does NOT fail closed across the board.
     *
     * This previously asserted `{ facts: 0, periods: 0 }` after calling
     * `seedBackedPeriod()`, which inserts facts, supply and FX but no
     * `reporting_periods` row at all — so the `periods: 0` half was satisfied by
     * an empty table and proved nothing. With a PUBLISHED period actually
     * present the claim is false: `reporting_periods_published` is granted `TO
     * reserveos_public`, `reserveos_app` is a member of that role, and Postgres
     * OR-combines permissive policies across every role the caller has
     * privileges of. `issuer_id = app_current_issuer()` is NULL and therefore
     * never true, but `status = 'PUBLISHED'` is, so the row is returned — along
     * with its `report_versions.payload` and its `issuers` row.
     *
     * That is exactly why `currentIssuerId` in src/services/period.ts raises
     * instead of returning null for an unbound transaction: "no tenant" is not a
     * safe state to answer queries in. Nothing in `src/` runs a bare
     * `withTransaction` against the application pool today — every route goes
     * through `inTenant`/`inPublicRole` and both workers use `withTenant` — so
     * this is a latent hazard, not a live leak. It is pinned here so that adding
     * such a call site is a visible decision rather than a silent one.
     */
    it('fails closed for published rows too when no tenant is bound', async () => {
      await seedBackedPeriod();
      await rivalPublished();

      const seen = await withTransaction(db, async (client) => {
        const facts = await client.query(`SELECT id FROM reserve_facts`);
        const periods = await client.query<{ id: string; issuer_id: string; status: string }>(
          `SELECT id, issuer_id, status FROM reporting_periods`,
        );
        const versions = await client.query(`SELECT id FROM report_versions`);
        const issuers = await client.query<{ id: string }>(`SELECT id FROM issuers`);
        return {
          facts: facts.rowCount,
          periods: periods.rows,
          versions: versions.rowCount,
          issuers: issuers.rows,
        };
      });

      // Non-vacuity: every table read here holds at least one row, so a policy
      // that failed open would return something.
      const present = await testPool().query<{ n: number }>(
        `SELECT (SELECT count(*) FROM reporting_periods)::int AS n`,
      );
      expect(present.rows[0]!.n).toBeGreaterThan(0);

      // Previously the published tables did NOT fail closed here, and this test
      // asserted the leak with a note to flip it if a migration ever narrowed
      // the policies to the reserveos_public role alone. Migration 009 did.
      expect(seen.facts).toBe(0);
      expect(seen.periods).toEqual([]);
      expect(seen.versions).toBe(0);
      expect(seen.issuers).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Cross-tenant reads by id
  // -------------------------------------------------------------------------
  describe('cross-tenant reads by id, after the owner has PUBLISHED', () => {
    it('404s every id-addressed read route and leaks no rival string', async () => {
      const rival = await rivalPublished();

      const reads = [
        `/api/periods/${rival.periodId}`,
        `/api/periods/${rival.periodId}/computation`,
        `/api/reports/${rival.versionId}`,
      ];

      for (const url of reads) {
        const response = await app.inject({ method: 'GET', url, headers: bearer(alice) });
        expect(
          { url, status: response.statusCode },
          `${url} must not disclose another tenant's record`,
        ).toEqual({ url, status: 404 });
        expect(response.body, url).not.toContain('Rival Trust Co');
        expect(response.body, url).not.toContain('rival@rival.test');
        expect(response.body, url).not.toContain(RIVAL_ISSUER_ID);
      }
    });

    /**
     * `GET /api/reports/:id/approvals` (src/api/routes/certification.ts) is the
     * one id-addressed read that does NOT call `requireVersion`. It answers 200
     * for a report version belonging to another tenant.
     *
     * It is not a disclosure: `approvals` carries only the tenant policy from
     * migration 005 — no `*_published` counterpart — so the rival's signatures
     * are filtered out by the database and the body is byte-identical to the
     * answer for a wholly unknown id. What it is, is a missing ownership check:
     * the endpoint invites the caller to sign a report it cannot see. The fix
     * is one line, `await requireVersion(client, versionId)`, but that file is
     * outside this reviewer's scope, so the behaviour is pinned rather than
     * changed. Tighten this to 404 when the check lands.
     */
    it('leaks no rival approval through the unguarded approvals endpoint', async () => {
      const rival = await rivalPublished();
      const unknown = '00000000-0000-4000-8000-000000000000';

      // The rival must actually have signed something. Asserting "no rival
      // signature leaked" against a version nobody has signed is satisfied by an
      // empty `approvals` table and would pass even if the row were fully
      // visible — the emptiness has to come from the policy, not the fixture.
      await testPool().query(
        `INSERT INTO approvals
           (report_version_id, role, actor_id, actor_email, decision, attestation_text,
            signature, pms_decision_id)
         VALUES ($1, 'PREPARER', $2, 'rival@rival.test', 'APPROVED', $3, 'sig-rival', 'pms-rival')`,
        [rival.versionId, rival.user.userId, RIVAL_ATTESTATION],
      );
      const seeded = await testPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM approvals WHERE report_version_id = $1`,
        [rival.versionId],
      );
      expect(seeded.rows[0]?.n, 'the fixture must create a rival signature').toBe(1);

      const foreign = await app.inject({
        method: 'GET',
        url: `/api/reports/${rival.versionId}/approvals`,
        headers: bearer(alice),
      });
      const missing = await app.inject({
        method: 'GET',
        url: `/api/reports/${unknown}/approvals`,
        headers: bearer(alice),
      });

      expect(foreign.json().approvals).toEqual([]);
      expect(foreign.body).not.toContain('Rival Trust Co');
      expect(foreign.body).not.toContain('rival@rival.test');
      expect(foreign.body).not.toContain(RIVAL_ATTESTATION);
      expect(foreign.body).not.toContain(RIVAL_ISSUER_ID);
      // `nextRole` is derived from the signatures the caller can see. The rival
      // has signed as PREPARER, so an unfiltered read would advance this to
      // COMPLIANCE and turn the endpoint into an existence oracle even with the
      // emails stripped.
      expect(foreign.json().nextRole).toBe('PREPARER');
      // Identical to the unknown-id answer, so it is not an existence oracle.
      expect(foreign.body).toBe(missing.body);

      // Positive control: the same request from the row's own tenant returns it.
      // Without this, every assertion above would still hold if the endpoint were
      // simply broken and returned nothing to anyone.
      const owner = await app.inject({
        method: 'GET',
        url: `/api/reports/${rival.versionId}/approvals`,
        headers: bearer(rival.user),
      });
      expect(owner.json().approvals).toHaveLength(1);
      expect(owner.body).toContain(RIVAL_ATTESTATION);
      expect(owner.json().nextRole).toBe('COMPLIANCE');
    });

    it('keeps the rival period out of the tenant list view', async () => {
      const rival = await rivalPublished();
      const response = await app.inject({
        method: 'GET',
        url: '/api/periods',
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().periods).toHaveLength(0);
      expect(response.body).not.toContain(rival.periodId);
    });

    it('answers a foreign id exactly as it answers an unknown one', async () => {
      const rival = await rivalPublished();
      const unknown = '00000000-0000-4000-8000-000000000000';

      for (const path of ['/api/periods', '/api/reports']) {
        const foreign = await app.inject({
          method: 'GET',
          url: `${path}/${path === '/api/periods' ? rival.periodId : rival.versionId}`,
          headers: bearer(alice),
        });
        const missing = await app.inject({
          method: 'GET',
          url: `${path}/${unknown}`,
          headers: bearer(alice),
        });
        expect(foreign.statusCode).toBe(missing.statusCode);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cross-tenant writes
  // -------------------------------------------------------------------------
  describe('cross-tenant writes', () => {
    it('refuses to generate a report against another tenant period', async () => {
      const rival = await rivalPublished();
      const before = await testPool().query(`SELECT id FROM report_versions WHERE period_id = $1`, [
        rival.periodId,
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/api/periods/${rival.periodId}/report`,
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(404);

      const after = await testPool().query(`SELECT id FROM report_versions WHERE period_id = $1`, [
        rival.periodId,
      ]);
      expect(after.rowCount).toBe(before.rowCount);
    });

    it('refuses to certify another tenant report version', async () => {
      const rival = await rivalPublished();

      const response = await app.inject({
        method: 'POST',
        url: `/api/reports/${rival.versionId}/approvals`,
        headers: bearer(alice),
        payload: { role: 'PREPARER', decision: 'APPROVED' },
      });
      expect(response.statusCode).toBe(404);

      const approvals = await testPool().query(
        `SELECT id FROM approvals WHERE report_version_id = $1`,
        [rival.versionId],
      );
      expect(approvals.rowCount).toBe(0);
    });

    /**
     * `report_versions.payload_hash` is UNIQUE across the whole table, not per
     * period, so generation has a recovery path: on 23505 it looks the hash up
     * and returns the existing version instead of creating a duplicate. That
     * lookup was unscoped, and RLS does not scope it either — a PUBLISHED row
     * is visible to every tenant. So the recovery could hand tenant A a version
     * belonging to tenant B.
     *
     * A natural collision needs a SHA-256 collision, since the payload embeds
     * the issuer id, so this is hardening rather than a live leak. The invariant
     * is worth asserting on its own terms regardless: generation for period P
     * must never return a version belonging to any other period.
     */
    it('never recovers another tenant version from a payload-hash collision', async () => {
      await seedBackedPeriod();
      const rival = await rivalPublished();

      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(alice),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const periodId = created.json().id as string;

      const first = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/report`,
        headers: bearer(alice),
      });
      expect(first.statusCode).toBe(201);
      const payloadHash = first.json().payloadHash as string;

      // Move Alice's hash onto the rival's published period, then make Alice
      // regenerate. Her insert now collides with a row she does not own.
      await testPool().query(`DELETE FROM report_versions WHERE period_id = $1`, [periodId]);
      await testPool().query(
        `UPDATE report_versions SET payload_hash = $1 WHERE period_id = $2`,
        [payloadHash, rival.periodId],
      );

      const again = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/report`,
        headers: bearer(alice),
      });

      if (again.statusCode === 201) {
        const returnedId = again.json().versionId as string;
        const { rows } = await testPool().query<{ period_id: string }>(
          `SELECT period_id FROM report_versions WHERE id = $1`,
          [returnedId],
        );
        expect(
          rows[0]?.period_id,
          'generation returned a version belonging to another period',
        ).toBe(periodId);
      } else {
        // Refusing outright is also correct; silently adopting the rival's row
        // is what must not happen.
        expect(again.statusCode).toBeGreaterThanOrEqual(400);
        expect(again.body).not.toContain(rival.versionId);
        expect(again.body).not.toContain(RIVAL_ISSUER_ID);
      }
    });

    it('refuses to publish another tenant period', async () => {
      const other = await seedOtherIssuer();
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(other.user),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const periodId = created.json().id as string;
      await testPool().query(`UPDATE reporting_periods SET status = 'CERTIFIED' WHERE id = $1`, [
        periodId,
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/publish`,
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(404);

      const { rows } = await testPool().query<{ status: string }>(
        `SELECT status FROM reporting_periods WHERE id = $1`,
        [periodId],
      );
      // Still CERTIFIED: a foreign publish must not move the rival's state.
      expect(rows[0]?.status).toBe('CERTIFIED');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Issuer provenance
  // -------------------------------------------------------------------------
  describe('issuer provenance', () => {
    it('ignores an issuerId supplied in the body, query string or both', async () => {
      await seedOtherIssuer();

      const created = await app.inject({
        method: 'POST',
        url: `/api/periods?issuerId=${RIVAL_ISSUER_ID}`,
        headers: bearer(alice),
        payload: {
          periodStart: '2026-03-01',
          periodEnd: '2026-03-31',
          issuerId: RIVAL_ISSUER_ID,
          issuer_id: RIVAL_ISSUER_ID,
        },
      });
      expect(created.statusCode).toBe(201);

      const { rows } = await testPool().query<{ issuer_id: string }>(
        `SELECT issuer_id FROM reporting_periods WHERE id = $1`,
        [created.json().id],
      );
      expect(rows[0]?.issuer_id).toBe(SEED_IDS.issuerId);
    });

    it('reports the principal issuer on /api/me regardless of query parameters', async () => {
      await seedOtherIssuer();
      const response = await app.inject({
        method: 'GET',
        url: `/api/me?issuerId=${RIVAL_ISSUER_ID}`,
        headers: bearer(alice),
      });
      expect(response.json().issuer.id).toBe(SEED_IDS.issuerId);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Over-exposure
  // -------------------------------------------------------------------------
  describe('response surface', () => {
    const CREDENTIAL_REF = 'vault://bny/prod/password';
    const RULE_SENTINEL = 'internal-threshold-sentinel';

    beforeEach(async () => {
      await testPool().query(
        `UPDATE custodians SET connector_config = $1::jsonb`,
        [JSON.stringify({ password_ref: CREDENTIAL_REF, host: 'sftp.bny.internal' })],
      );
      await testPool().query(`UPDATE issuers SET rule_config = $1::jsonb WHERE id = $2`, [
        JSON.stringify({ marker: RULE_SENTINEL }),
        SEED_IDS.issuerId,
      ]);
    });

    it('never returns credential references, environment ids or rule config', async () => {
      await seedBackedPeriod();
      await testPool().query(
        `INSERT INTO source_documents
           (issuer_id, custodian_id, filename, content_hash, byte_size, status, ingested_at)
         VALUES ($1, $2, 'bny-2026-03-31.csv', $3, 1024, 'INGESTED', now())`,
        [SEED_IDS.issuerId, SEED_IDS.bny, 'f'.repeat(64)],
      );

      const period = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(alice),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const periodId = period.json().id as string;
      const generated = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/report`,
        headers: bearer(alice),
      });
      expect(generated.statusCode).toBe(201);
      const versionId = generated.json().versionId as string;

      const urls = [
        '/api/me',
        '/api/custodians',
        '/api/documents',
        '/api/deployments',
        '/api/redemptions/open',
        `/api/periods/${periodId}`,
        `/api/periods/${periodId}/computation`,
        `/api/reports/${versionId}`,
      ];

      for (const url of urls) {
        const response = await app.inject({ method: 'GET', url, headers: bearer(alice) });
        expect(response.statusCode, url).toBe(200);
        const body = response.body;
        expect(body, `${url} leaks a credential reference`).not.toContain(CREDENTIAL_REF);
        expect(body, `${url} leaks connectorConfig`).not.toContain('connectorConfig');
        expect(body, `${url} leaks connector_config`).not.toContain('connector_config');
        expect(body, `${url} leaks the Kaleido environment id`).not.toContain('env-test');
        expect(body, `${url} leaks kaleidoEnvId`).not.toContain('aleidoEnv');
        expect(body, `${url} leaks the Kaleido connector id`).not.toContain('conn-eth');
        expect(body, `${url} leaks rule_config`).not.toContain(RULE_SENTINEL);
        expect(body, `${url} leaks ruleConfig`).not.toContain('ruleConfig');
      }
    });

    it('does not return token material or another user email on /api/me', async () => {
      const bob = await seedUser({ roles: ['CFO'], email: 'bob@acme.test' });
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('bob@acme.test');
      expect(response.body).not.toContain(alice.token);
      expect(response.body).not.toContain(bob.token);
      expect(response.body).not.toContain('tokenId');
      expect(response.body).not.toContain('token_hash');
      expect(response.json().user.email).toBe('alice@acme.test');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Money crosses the wire as decimal strings
  // -------------------------------------------------------------------------
  describe('money on the wire', () => {
    /** Keys whose value is a quantity that must never be a JSON number. */
    const QUANTITY_KEY = /(Usd|Ratio|Raw|Minor)$|^percent|^blockNumber$|^byteSize$/;

    function walk(node: unknown, path: string, hit: (path: string, value: unknown) => void): void {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`, hit));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (QUANTITY_KEY.test(key)) hit(`${path}.${key}`, value);
        walk(value, `${path}.${key}`, hit);
      }
    }

    it('renders every monetary field of the computation as a string, in the raw bytes', async () => {
      await seedBackedPeriod();
      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(alice),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const periodId = created.json().id as string;

      const response = await app.inject({
        method: 'GET',
        url: `/api/periods/${periodId}/computation`,
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(200);

      // Parse the raw body text: reading the already-decoded object would not
      // distinguish 1.5 from "1.5", which is the entire question.
      const raw = response.body;
      const parsed: unknown = JSON.parse(raw);

      const offenders: string[] = [];
      const inspected: string[] = [];
      walk(parsed, '$', (path, value) => {
        inspected.push(path);
        if (value !== null && typeof value !== 'string') {
          offenders.push(`${path} = ${JSON.stringify(value)} (${typeof value})`);
        }
      });
      expect(offenders, 'monetary fields must be decimal strings or null').toEqual([]);

      // Non-vacuity: totals, per-category composition, custody by jurisdiction
      // and per-chain supply must all have been reached. Without this the walk
      // above would pass just as happily over an empty response.
      expect(inspected.length, 'the walk found no quantity fields to check').toBeGreaterThan(12);
      expect(inspected).toContain('$.totalReserveValueUsd');
      expect(inspected).toContain('$.composition[0].marketValueUsd');
      expect(inspected).toContain('$.custodyByJurisdiction[0].marketValueUsd');
      expect(inspected).toContain('$.outstandingByChain[0].totalSupplyRaw');

      // And directly against the bytes: no `"<quantityKey>": <number>` anywhere.
      const numericField = /"(\w*(?:Usd|Ratio|Raw|Minor)|percent\w*|blockNumber)"\s*:\s*-?\d/;
      expect(numericField.test(raw), `raw body contains a JSON number quantity: ${raw}`).toBe(
        false,
      );

      // The fixture is large enough that a Number round-trip would be lossy.
      expect(JSON.parse(raw).totalReserveValueUsd).toBe('10500000.00');
    });

    it('renders redemption and document quantities as strings too', async () => {
      await testPool().query(
        `INSERT INTO redemption_requests
           (issuer_id, external_ref, requested_at, amount_minor, sla_deadline, status)
         VALUES ($1, 'RQ-1', now(), 123456789012345678, now() + interval '2 days', 'RECEIVED')`,
        [SEED_IDS.issuerId],
      );
      await testPool().query(
        `INSERT INTO source_documents
           (issuer_id, custodian_id, filename, content_hash, byte_size, status, ingested_at)
         VALUES ($1, $2, 'big.csv', $3, 9007199254740993, 'INGESTED', now())`,
        [SEED_IDS.issuerId, SEED_IDS.bny, 'a'.repeat(64)],
      );

      const redemptions = await app.inject({
        method: 'GET',
        url: '/api/redemptions/open',
        headers: bearer(alice),
      });
      expect(redemptions.json().redemptions[0].amountUsd).toBe('1234567890123456.78');

      const documents = await app.inject({
        method: 'GET',
        url: '/api/documents',
        headers: bearer(alice),
      });
      // 2^53 + 1: a JSON number here would come back as 9007199254740992.
      expect(documents.json().documents[0].byteSize).toBe('9007199254740993');
    });
  });

  // -------------------------------------------------------------------------
  // 7. VIEWER reach
  // -------------------------------------------------------------------------
  describe('VIEWER reach', () => {
    it('lets a VIEWER read the full report of its own tenant but write nothing', async () => {
      await seedBackedPeriod();
      const viewer = await seedUser({ roles: ['VIEWER'], email: 'viewer@acme.test' });

      const created = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(alice),
        payload: { periodStart: '2026-03-01', periodEnd: '2026-03-31' },
      });
      const periodId = created.json().id as string;
      const generated = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/report`,
        headers: bearer(alice),
      });
      const versionId = generated.json().versionId as string;

      const read = await app.inject({
        method: 'GET',
        url: `/api/reports/${versionId}`,
        headers: bearer(viewer),
      });
      expect(read.statusCode).toBe(200);

      // Every mutating route stays shut.
      const open = await app.inject({
        method: 'POST',
        url: '/api/periods',
        headers: bearer(viewer),
        payload: { periodStart: '2026-04-01', periodEnd: '2026-04-30' },
      });
      expect(open.statusCode).toBe(403);

      const regenerate = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/report`,
        headers: bearer(viewer),
      });
      expect(regenerate.statusCode).toBe(403);

      const publish = await app.inject({
        method: 'POST',
        url: `/api/periods/${periodId}/publish`,
        headers: bearer(viewer),
      });
      expect(publish.statusCode).toBe(403);
    });

    it('does not let a VIEWER of one tenant read another tenant report', async () => {
      const rival = await rivalPublished();
      const viewer = await seedUser({ roles: ['VIEWER'], email: 'viewer2@acme.test' });
      const response = await app.inject({
        method: 'GET',
        url: `/api/reports/${rival.versionId}`,
        headers: bearer(viewer),
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
