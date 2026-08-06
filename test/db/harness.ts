import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { createPool, withTransaction } from '../../src/db/pool.js';

/**
 * Postgres test harness.
 *
 * Database tests run against a real Postgres because the things most likely to
 * break here — type coercion, timezone handling, constraint enforcement — are
 * precisely the behaviours a mock would paper over. When no database is
 * reachable the suites skip rather than fail, so `npm test` still works on a
 * machine without Docker.
 *
 *   docker run -d --name reserveos-pg -e POSTGRES_PASSWORD=dev \
 *     -e POSTGRES_DB=reserveos -p 55432:5432 postgres:16-alpine
 */

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:dev@localhost:55432/reserveos';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

let cachedPool: pg.Pool | null = null;
let availability: Promise<boolean> | null = null;

/** True when a test database is reachable and migrated. Probed once per process. */
export function databaseAvailable(): Promise<boolean> {
  availability ??= (async () => {
    try {
      const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 4 });
      await pool.query('SELECT 1');
      await applyMigrations(pool);
      cachedPool = pool;
      return true;
    } catch {
      return false;
    }
  })();
  return availability;
}

export function testPool(): pg.Pool {
  if (cachedPool === null) {
    throw new Error('database not available; guard the suite with databaseAvailable()');
  }
  return cachedPool;
}

async function applyMigrations(pool: pg.Pool): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pool.query(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Re-running migrations against an already-migrated database is expected.
      if (/already exists/i.test(message)) continue;
      throw new Error(`migration ${file} failed: ${message}`);
    }
  }
}

const MUTABLE_TABLES = [
  'access_log',
  'anchors',
  'approvals',
  'report_versions',
  'reporting_periods',
  'redemption_requests',
  'reserve_facts',
  'source_documents',
  'supply_facts',
  'fx_rates',
  'token_deployments',
  'custodians',
  'issuers',
];

/** Wipe all data between tests. Runs as the owner, bypassing append-only grants. */
export async function resetDatabase(): Promise<void> {
  const pool = testPool();
  await pool.query(`TRUNCATE ${MUTABLE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface SeededTenant {
  readonly issuerId: string;
  readonly custodianIds: { bny: string; stateStreet: string; euroclear: string };
  readonly deploymentIds: { ethereum: string; base: string };
}

export const SEED_IDS = {
  issuerId: '11111111-1111-1111-1111-111111111111',
  bny: '22222222-2222-2222-2222-222222222221',
  stateStreet: '22222222-2222-2222-2222-222222222222',
  euroclear: '22222222-2222-2222-2222-222222222223',
  ethereum: '33333333-3333-3333-3333-333333333331',
  base: '33333333-3333-3333-3333-333333333332',
} as const;

/** Insert the reference data the fixtures assume. */
export async function seedTenant(): Promise<SeededTenant> {
  const pool = testPool();

  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO issuers (id, legal_name, regulator, kaleido_env_id)
       VALUES ($1, $2, $3, $4)`,
      [SEED_IDS.issuerId, 'Acme Digital Trust Company, N.A.', 'OCC', 'env-test'],
    );

    await client.query(
      `INSERT INTO custodians (id, issuer_id, name, jurisdiction, connector_type, connector_config)
       VALUES ($1, $4, 'BNY Mellon',   'US', 'sftp_csv', '{}'),
              ($2, $4, 'State Street', 'US', 'sftp_csv', '{}'),
              ($3, $4, 'Euroclear',    'BE', 'api_rest', '{}')`,
      [SEED_IDS.bny, SEED_IDS.stateStreet, SEED_IDS.euroclear, SEED_IDS.issuerId],
    );

    await client.query(
      `INSERT INTO token_deployments
         (id, issuer_id, chain_id, contract_address, symbol, decimals, kaleido_connector_id, active)
       VALUES ($1, $3, 1,    '0xaaaa000000000000000000000000000000000001', 'ACME', 6, 'conn-eth',  TRUE),
              ($2, $3, 8453, '0xbbbb000000000000000000000000000000000002', 'ACME', 6, 'conn-base', TRUE)`,
      [SEED_IDS.ethereum, SEED_IDS.base, SEED_IDS.issuerId],
    );
  });

  return {
    issuerId: SEED_IDS.issuerId,
    custodianIds: {
      bny: SEED_IDS.bny,
      stateStreet: SEED_IDS.stateStreet,
      euroclear: SEED_IDS.euroclear,
    },
    deploymentIds: { ethereum: SEED_IDS.ethereum, base: SEED_IDS.base },
  };
}

const APP_LOGIN = 'reserveos_test_login';
const APP_PASSWORD = 'apptest';

let cachedAppPool: pg.Pool | null = null;

/**
 * A pool that connects as an unprivileged login role granted `reserveos_app`.
 *
 * `testPool()` is a superuser and therefore bypasses row-level security, so it
 * cannot prove anything about tenant isolation or about code paths that must
 * set `app.issuer_id`. Anything asserting those needs this pool instead —
 * otherwise the test passes no matter what the policies say.
 */
export async function appPool(): Promise<pg.Pool> {
  if (cachedAppPool !== null) return cachedAppPool;

  const admin = testPool();
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_LOGIN}') THEN
        CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await admin.query(`GRANT reserveos_app TO ${APP_LOGIN}`);

  const url = new URL(TEST_DATABASE_URL);
  url.username = APP_LOGIN;
  url.password = APP_PASSWORD;

  cachedAppPool = createPool({ connectionString: url.toString(), max: 4 });
  return cachedAppPool;
}

/** Close the shared pool. Call from a global teardown. */
export async function closeTestPool(): Promise<void> {
  if (cachedPool !== null) {
    await cachedPool.end();
    cachedPool = null;
    availability = null;
  }
}
