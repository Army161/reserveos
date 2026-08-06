/**
 * Apply database migrations.
 *
 * Run: npm run db:migrate    (requires DATABASE_URL)
 *
 * Migrations are tracked in `schema_migrations` and applied inside a
 * transaction each, so a failure leaves the database on the last good version
 * rather than half-migrated.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connectionStringFromEnv, createPool, withTransaction } from '../src/db/pool.js';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

async function main(): Promise<void> {
  const pool = createPool({ connectionString: connectionStringFromEnv() });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    CHAR(64) NOT NULL,
        applied_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>();
    const { rows } = await pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    for (const row of rows) applied.set(row.filename, row.checksum);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const filename of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(filename);

      if (previous !== undefined) {
        // An edited migration means the database and the repo disagree about
        // what schema is deployed. Refuse rather than guess which is right.
        if (previous !== checksum) {
          throw new Error(
            `migration ${filename} has changed since it was applied ` +
              `(recorded ${previous.slice(0, 12)}, found ${checksum.slice(0, 12)}); ` +
              'add a new migration instead of editing an applied one',
          );
        }
        continue;
      }

      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        );
      });

      console.log(`applied ${filename}`);
      count += 1;
    }

    console.log(count === 0 ? 'database is up to date' : `applied ${count} migration(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
