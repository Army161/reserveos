/**
 * Server entrypoint.
 *
 * Run: npm run start   (requires DATABASE_URL)
 *
 * The Kaleido client is still the in-memory fake: the real one needs the
 * provisioning spike described in build-v1.md section 4. Everything else —
 * ingestion, reconciliation, certification, verification — runs for real.
 */
import { connectionStringFromEnv, createPool } from './db/pool.js';
import { createServer } from './api/server.js';
import { FakeKaleidoClient } from './kaleido/fake.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

const pool = createPool({ connectionString: connectionStringFromEnv() });

const app = createServer({
  pool,
  kaleido: new FakeKaleidoClient(),
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
