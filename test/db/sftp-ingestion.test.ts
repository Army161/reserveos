import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import SftpClient from 'ssh2-sftp-client';
import { databaseAvailable, resetDatabase, seedTenant, testPool, SEED_IDS } from './harness.js';
import { SftpStatementSource } from '../../src/ingest/sftp.js';
import { StatementIngestionWorker, type CustodianFeed } from '../../src/ingest/statement-worker.js';
import { PgReserveFactStore } from '../../src/db/stores/facts.js';
import { PgSourceDocumentStore } from '../../src/db/stores/documents.js';
import { computePeriod } from '../../src/domain/reconciliation.js';
import { PgCustodianStore, PgTokenDeploymentStore } from '../../src/db/stores/reference.js';
import { FX_SCALE } from '../../src/domain/money.js';
import type { StatementMapping } from '../../src/ingest/mapping.js';

/**
 * The whole chain over real infrastructure: a file lands on an SSH server and
 * ends up as reconciled reserve figures in Postgres.
 *
 * Everything below the transport is already covered by the in-memory ingestion
 * suite. What this adds is the parts only a real server exercises — the SFTP
 * handshake, remote path separators, and rename semantics — wired to the real
 * database rather than a stand-in.
 */

const run = promisify(execFile);

const HOST = '127.0.0.1';
const PORT = 2222;
const USERNAME = 'custodian';
const PASSWORD = 'secret';
const INBOX = 'inbox';

async function readFingerprint(): Promise<string | null> {
  try {
    const { stdout } = await run('docker', [
      'exec',
      'reserveos-sftp',
      'ssh-keygen',
      '-l',
      '-f',
      '/etc/ssh/ssh_host_ed25519_key.pub',
    ]);
    return /SHA256:[A-Za-z0-9+/]+/.exec(stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

const FINGERPRINT = await readFingerprint();
const dbReady = await databaseAvailable();
const available = dbReady && FINGERPRINT !== null;

const MAPPING: StatementMapping = {
  columns: {
    category: 'Asset Type',
    marketValue: 'Market Value',
    faceValue: 'Par Value',
    cusip: 'CUSIP',
    maturityDate: 'Maturity',
  },
  dateFormat: 'ISO',
  defaultCurrency: 'USD',
};

const STATEMENT = [
  'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date',
  '"US Treasury Bill",912797KL0,"5,000,000.00","4,992,150.00",2026-05-15,2026-03-31',
  '"Demand Deposit",,"2,000,000.00","2,000,000.00",,2026-03-31',
  '',
].join('\r\n');

async function withAdminClient<T>(fn: (client: SftpClient) => Promise<T>): Promise<T> {
  const client = new SftpClient('admin');
  await client.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD });
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetInbox(): Promise<void> {
  await withAdminClient(async (client) => {
    for (const dir of [INBOX, `${INBOX}/processed`, `${INBOX}/failed`]) {
      if ((await client.exists(dir)) === false) continue;
      for (const entry of await client.list(dir)) {
        if (entry.type === '-') await client.delete(`${dir}/${entry.name}`);
      }
    }
  });
}

describe.skipIf(!available)('SFTP to Postgres, end to end', () => {
  let source: SftpStatementSource;

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await resetInbox();
    source = new SftpStatementSource({
      id: 'bny-sftp',
      host: HOST,
      port: PORT,
      username: USERNAME,
      credentials: { password: PASSWORD },
      directory: INBOX,
      hostKeyFingerprint: FINGERPRINT!,
    });
  });

  afterEach(async () => {
    await source.dispose();
    await resetInbox();
  });

  function feed(): CustodianFeed {
    return {
      issuerId: SEED_IDS.issuerId,
      custodianId: SEED_IDS.bny,
      source,
      mapping: MAPPING,
      statementDate: { kind: 'column', column: 'Statement Date' },
    };
  }

  it('carries a statement from the SSH server into reconciled figures', async () => {
    await withAdminClient((client) =>
      client.put(Buffer.from(STATEMENT, 'utf8'), `${INBOX}/bny-2026-03-31.csv`),
    );

    const worker = new StatementIngestionWorker({
      pool: testPool(),
      now: () => new Date('2026-04-01T09:00:00.000Z'),
    });
    const [outcome] = await worker.run(feed());

    expect(outcome!.status).toBe('INGESTED');
    expect(outcome!.factsInserted).toBe(2);

    // The file moved out of the pending set on the remote server.
    expect(await source.list()).toEqual([]);
    const archived = await withAdminClient((client) =>
      client.get(`${INBOX}/processed/bny-2026-03-31.csv`),
    );
    expect((archived as Buffer).toString('utf8')).toBe(STATEMENT);

    // And the figures reconcile.
    const pool = testPool();
    const periodEnd = new Date('2026-03-31T23:59:59.999Z');
    const computation = computePeriod({
      asOf: periodEnd,
      facts: await new PgReserveFactStore(pool).listCurrentAsOf(SEED_IDS.issuerId, periodEnd),
      supplyFacts: [],
      deployments: await new PgTokenDeploymentStore(pool).listActiveForIssuer(SEED_IDS.issuerId),
      custodians: await new PgCustodianStore(pool).listForIssuer(SEED_IDS.issuerId),
      fx: { asOf: periodEnd, source: 'ECB', ratesToUsd: new Map([['USD', FX_SCALE]]) },
    });

    // 4,992,150.00 + 2,000,000.00 — quoted thousands separators intact through
    // SFTP, CRLF line endings, CSV parsing and the database.
    expect(computation.totalReserveValueMinor).toBe(699_215_000n);

    const documents = await new PgSourceDocumentStore(pool).listForIssuer(SEED_IDS.issuerId);
    expect(documents[0]!.filename).toBe('bny-2026-03-31.csv');
    expect(documents[0]!.status).toBe('INGESTED');
  });

  it('quarantines a bad statement on the server and writes nothing', async () => {
    await withAdminClient((client) =>
      client.put(
        Buffer.from(
          'Asset Type,CUSIP,Par Value,Market Value,Maturity,Statement Date\r\n' +
            '"Corporate Bond",912797KL0,"1.00","1.00",2026-05-15,2026-03-31\r\n',
          'utf8',
        ),
        `${INBOX}/bad.csv`,
      ),
    );

    const worker = new StatementIngestionWorker({
      pool: testPool(),
      now: () => new Date('2026-04-01T09:00:00.000Z'),
    });
    const [outcome] = await worker.run(feed());

    expect(outcome!.status).toBe('REJECTED');
    expect(await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(0);

    const reason = await withAdminClient((client) =>
      client.get(`${INBOX}/failed/bad.csv.error.txt`),
    );
    expect((reason as Buffer).toString('utf8').length).toBeGreaterThan(0);
  });

  it('treats a redelivered file as a duplicate', async () => {
    const worker = new StatementIngestionWorker({
      pool: testPool(),
      now: () => new Date('2026-04-01T09:00:00.000Z'),
    });

    await withAdminClient((client) =>
      client.put(Buffer.from(STATEMENT, 'utf8'), `${INBOX}/first.csv`),
    );
    await worker.run(feed());

    await withAdminClient((client) =>
      client.put(Buffer.from(STATEMENT, 'utf8'), `${INBOX}/second.csv`),
    );
    const [outcome] = await worker.run(feed());

    expect(outcome!.status).toBe('DUPLICATE');
    expect(await new PgReserveFactStore(testPool()).listAllForIssuer(SEED_IDS.issuerId)).toHaveLength(2);
  });
});
