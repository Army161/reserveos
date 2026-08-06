import pg from 'pg';
import { configureTypeParsers } from './types.js';

// Applied at import time, before any pool exists, so no connection can ever be
// created with the driver's unsafe DATE and NUMERIC defaults in force.
configureTypeParsers();

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
}

/**
 * Create a connection pool.
 *
 * Every session is pinned to UTC. Postgres renders TIMESTAMPTZ in the session
 * zone, and while the driver parses the offset correctly either way, a UTC
 * session keeps server-side date arithmetic and anything a human runs in psql
 * consistent with the UTC-only reasoning the domain layer does.
 */
export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // A hung query must not pin a connection forever; the ingestion workers run
    // unattended.
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
    // Applied as a startup parameter rather than a post-connect `SET`. A `SET`
    // issued from the 'connect' handler is not awaited by the pool, so it races
    // the first real query on that connection — the session could serve a query
    // before the zone is applied.
    options: '-c timezone=UTC',
  });

  // Without a listener, an idle-client error from the driver is an unhandled
  // 'error' event and takes the whole worker process down.
  pool.on('error', (error) => {
    console.error('[db] idle client error', error);
  });

  return pool;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Ingestion writes a statement's rows as one unit: a partially-applied custodian
 * statement would look like a real position change to the reconciliation engine.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Report but do not mask the original failure.
      console.error('[db] rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction scoped to one issuer.
 *
 * Sets `app.issuer_id`, which the row-level security policies in migration 005
 * read. Every query inside is filtered to that tenant by the database, so a
 * store method that forgets an `issuer_id` predicate returns nothing rather than
 * another issuer's reserve positions.
 *
 * `SET LOCAL` scope is the transaction, so the setting cannot leak to the next
 * caller when the pooled connection is reused — which is exactly the bug a
 * session-level `SET` would introduce.
 *
 * Note this only binds when the connection is NOT a superuser or the table
 * owner, both of which bypass RLS. Migrations and genuinely cross-tenant sweeps
 * rely on that; the application must connect as `reserveos_app`.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  issuerId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  // A malformed id would make `app_current_issuer()` raise mid-query with an
  // opaque cast error; reject it here where the message can name the caller.
  if (!UUID_SHAPE.test(issuerId)) {
    throw new TypeError(`issuer id is not a UUID: ${issuerId}`);
  }

  return withTransaction(pool, async (client) => {
    // `set_config` rather than `SET LOCAL`, because SET does not accept bind
    // parameters and interpolating the value would be an injection point.
    await client.query('SELECT set_config($1, $2, true)', ['app.issuer_id', issuerId]);
    return fn(client);
  });
}

/**
 * Run `fn` as the `reserveos_public` role.
 *
 * Serves the unauthenticated examiner endpoint. That role's policies (migration
 * 006) restrict it to PUBLISHED periods and their report versions and anchors,
 * so a routing mistake in the handler cannot expose a draft period — the
 * database refuses regardless of what the query asks for.
 *
 * `SET LOCAL ROLE` reverts at the end of the transaction, so a pooled connection
 * cannot carry the reduced role into the next caller.
 */
export async function withPublicRole<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query('SET LOCAL ROLE reserveos_public');
    return fn(client);
  });
}

/** Connection string from the environment, with a clear failure when absent. */
export function connectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}
