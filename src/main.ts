/**
 * Server entrypoint.
 *
 * Run: npm run start   (requires DATABASE_URL)
 *
 * The Kaleido client is real when KALEIDO_API_URL is set, the in-memory fake
 * otherwise. "Real" is qualified: `kaleidoClientFromEnv` grounds anchoring and
 * token-supply reads in verified FireFly/evmconnect source, but two seams —
 * PMS policy evaluation's exact route, and block context for a supply read —
 * are not confirmed against a live Kaleido environment, because no
 * credentials exist yet to confirm them against. See src/kaleido/rest.ts's
 * file header before pointing this at a real environment.
 */
import { connectionStringFromEnv, createPool } from './db/pool.js';
import { createServer } from './api/server.js';
import { FakeKaleidoClient } from './kaleido/fake.js';
import { kaleidoClientFromEnv } from './kaleido/rest.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

const pool = createPool({ connectionString: connectionStringFromEnv() });
const kaleido = kaleidoClientFromEnv() ?? new FakeKaleidoClient();

const app = createServer({
  pool,
  kaleido,
  logger: true,
  ...(process.env['FX_SOURCE'] === undefined ? {} : { fxSource: process.env['FX_SOURCE'] }),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  // Close the server before the pool: an in-flight certification must be allowed
  // to commit rather than losing its connection mid-transaction.
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port, host });
  app.log.info(`examiner portal at http://${host}:${port}/portal`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
