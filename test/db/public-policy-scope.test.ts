import { beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';

/**
 * The public-verification policies must not widen the authenticated app role.
 *
 * `GRANT reserveos_public TO reserveos_app` exists so the API can downgrade
 * itself with SET LOCAL ROLE to serve the unauthenticated endpoint. Postgres
 * matches policy roles by MEMBERSHIP, so without a `current_user` guard every
 * `TO reserveos_public` policy also applied to the ordinary app role — and
 * because permissive policies are OR'd, "your own rows" quietly became "your own
 * rows, or anyone's published ones".
 *
 * These tests pin both halves: the app role sees only its tenant even when
 * another tenant has published, and the public role still sees published data
 * once the session actually runs as it.
 */

const available = await databaseAvailable();

const RIVAL = '99999999-9999-9999-9999-999999999999';

async function asRole<T>(
  role: string,
  issuerId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (issuerId !== null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.issuer_id', issuerId]);
    }
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!available)('public policies do not widen the app role', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();

    const pool = testPool();
    await pool.query(
      `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
       VALUES ($1, 'Rival Trust Co', 'NYDFS', 'env-rival')`,
      [RIVAL],
    );
    // Both tenants publish. The rival's rows are the ones that used to leak.
    await pool.query(
      `INSERT INTO reporting_periods (issuer_id, period_start, period_end, status)
       VALUES ($1, '2026-03-01', '2026-03-31', 'PUBLISHED'),
              ($2, '2026-03-01', '2026-03-31', 'PUBLISHED')`,
      [SEED_IDS.issuerId, RIVAL],
    );
  });

  it('confirms the membership rule that made this possible', async () => {
    const { rows } = await testPool().query<{ member: boolean }>(
      `SELECT pg_has_role('reserveos_app','reserveos_public','MEMBER') AS member`,
    );
    // True by design — the API needs SET ROLE. That is exactly why the policies
    // cannot rely on the role list alone.
    expect(rows[0]!.member).toBe(true);
  });

  it('shows the app role only its own tenant, though another has published', async () => {
    const periods = await asRole('reserveos_app', SEED_IDS.issuerId, async (client) => {
      const { rows } = await client.query<{ issuer_id: string }>(
        'SELECT issuer_id FROM reporting_periods',
      );
      return rows;
    });

    expect(periods).toHaveLength(1);
    expect(periods[0]!.issuer_id).toBe(SEED_IDS.issuerId);
    expect(periods.some((row) => row.issuer_id === RIVAL)).toBe(false);
  });

  it('hides another tenant issuer record from the app role', async () => {
    const issuers = await asRole('reserveos_app', SEED_IDS.issuerId, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM issuers');
      return rows.map((row) => row.id);
    });

    expect(issuers).toEqual([SEED_IDS.issuerId]);
  });

  it('still lets the public role read published periods once it is the current role', async () => {
    // The endpoint must keep working: this is the half a careless fix breaks.
    const periods = await asRole('reserveos_public', null, async (client) => {
      const { rows } = await client.query<{ issuer_id: string }>(
        'SELECT issuer_id FROM reporting_periods',
      );
      return rows.map((row) => row.issuer_id);
    });

    expect(periods).toHaveLength(2);
    expect(periods).toContain(SEED_IDS.issuerId);
    expect(periods).toContain(RIVAL);
  });

  it('keeps unpublished periods hidden from the public role', async () => {
    await testPool().query(
      `INSERT INTO reporting_periods (issuer_id, period_start, period_end, status)
       VALUES ($1, '2026-04-01', '2026-04-30', 'CERTIFIED')`,
      [SEED_IDS.issuerId],
    );

    const statuses = await asRole('reserveos_public', null, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM reporting_periods',
      );
      return rows.map((row) => row.status);
    });

    expect(statuses.every((status) => status === 'PUBLISHED')).toBe(true);
  });

  it('gives the app role nothing at all when no tenant is set', async () => {
    // Fail closed: the public policies must not become a fallback for an
    // unscoped authenticated session either.
    const count = await asRole('reserveos_app', null, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM reporting_periods',
      );
      return rows[0]!.n;
    });

    expect(count).toBe('0');
  });
});
