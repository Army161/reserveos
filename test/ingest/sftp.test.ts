import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import SftpClient from 'ssh2-sftp-client';
import {
  hostKeyFingerprint,
  remoteJoin,
  SftpHostKeyError,
  SftpStatementSource,
} from '../../src/ingest/sftp.js';

/**
 * SFTP transport, exercised against a real SSH server.
 *
 * A mocked SFTP client would prove nothing about the parts that actually break:
 * host key verification, remote path separators, and rename semantics. The
 * server runs in Docker:
 *
 *   docker run -d --name reserveos-sftp -p 2222:22 atmoz/sftp:alpine \
 *     "custodian:secret:::inbox"
 *
 * The suite skips when it is not reachable, so `npm test` still works without it.
 */

const run = promisify(execFile);

const HOST = '127.0.0.1';
const PORT = 2222;
const USERNAME = 'custodian';
const PASSWORD = 'secret';
const INBOX = 'inbox';

/** Read the container's real host key fingerprint; it is regenerated per container. */
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
    const match = /SHA256:[A-Za-z0-9+/]+/.exec(stdout);
    return match?.[0] ?? null;
  } catch {
    return null;
  }
}

const FINGERPRINT = await readFingerprint();
const available = FINGERPRINT !== null;

function source(overrides: { fingerprint?: string } = {}): SftpStatementSource {
  return new SftpStatementSource({
    id: 'bny-sftp',
    host: HOST,
    port: PORT,
    username: USERNAME,
    credentials: { password: PASSWORD },
    directory: INBOX,
    hostKeyFingerprint: overrides.fingerprint ?? FINGERPRINT!,
  });
}

/** Direct client for arranging fixtures, bypassing the class under test. */
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

describe('remoteJoin', () => {
  it('always uses forward slashes, whatever the host OS', () => {
    expect(remoteJoin('inbox', 'processed', 'a.csv')).toBe('inbox/processed/a.csv');
    expect(remoteJoin('/inbox/', '/processed/')).toBe('/inbox/processed');
  });

  it('never emits a backslash, which a server would treat as part of a filename', () => {
    expect(remoteJoin('inbox', 'sub', 'file.csv')).not.toContain('\\');
  });

  it('drops empty segments', () => {
    expect(remoteJoin('inbox', '', 'a.csv')).toBe('inbox/a.csv');
  });
});

describe('hostKeyFingerprint', () => {
  it('matches the unpadded base64 SHA-256 form ssh-keygen prints', () => {
    // Known vector: SHA-256 of the empty input.
    expect(hostKeyFingerprint(Buffer.alloc(0))).toBe(
      'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU',
    );
    expect(hostKeyFingerprint(Buffer.alloc(0))).not.toMatch(/=$/);
  });
});

describe.skipIf(!available)('SftpStatementSource', () => {
  let sources: SftpStatementSource[] = [];

  function track(instance: SftpStatementSource): SftpStatementSource {
    sources.push(instance);
    return instance;
  }

  beforeAll(async () => {
    await resetInbox();
  });

  afterEach(async () => {
    for (const instance of sources) await instance.dispose();
    sources = [];
    await resetInbox();
  });

  afterAll(async () => {
    await resetInbox();
  });

  it('rejects a server whose host key does not match the pin', async () => {
    const wrong = track(
      source({ fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    );

    // Without a pin, ssh2 accepts any host key and a MITM sees a bank's entire
    // reserve position in clear.
    await expect(wrong.list()).rejects.toThrow(SftpHostKeyError);
  });

  it('names both fingerprints so an operator can tell rotation from interception', async () => {
    const wrong = track(
      source({ fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    );

    await expect(wrong.list()).rejects.toThrow(/expected SHA256:AAA.*presented SHA256:/s);
  });

  it('connects and lists an empty inbox', async () => {
    expect(await track(source()).list()).toEqual([]);
  });

  it('lists only files with the configured extension', async () => {
    await withAdminClient(async (client) => {
      await client.put(Buffer.from('a'), `${INBOX}/positions.csv`);
      await client.put(Buffer.from('b'), `${INBOX}/notes.txt`);
      await client.put(Buffer.from('c'), `${INBOX}/UPPER.CSV`);
    });

    const names = (await track(source()).list()).map((f) => f.name).sort();
    expect(names).toEqual(['UPPER.CSV', 'positions.csv']);
  });

  it('reads exact bytes, including content a naive text read would mangle', async () => {
    const content = 'coupon,"1,234.56"\r\nunicode,café\r\n';
    await withAdminClient((client) => client.put(Buffer.from(content, 'utf8'), `${INBOX}/a.csv`));

    const instance = track(source());
    const [file] = await instance.list();
    const bytes = await instance.read(file!);

    expect(bytes.toString('utf8')).toBe(content);
    expect(file!.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('moves a processed file out of the pending set and keeps the bytes', async () => {
    await withAdminClient((client) => client.put(Buffer.from('payload'), `${INBOX}/a.csv`));

    const instance = track(source());
    const [file] = await instance.list();
    await instance.markProcessed(file!);

    expect(await instance.list()).toEqual([]);
    const moved = await withAdminClient((client) => client.get(`${INBOX}/processed/a.csv`));
    expect((moved as Buffer).toString('utf8')).toBe('payload');
  });

  it('is idempotent when a processed file is marked again after a crash', async () => {
    await withAdminClient((client) => client.put(Buffer.from('payload'), `${INBOX}/a.csv`));

    const instance = track(source());
    const [file] = await instance.list();
    await instance.markProcessed(file!);

    // The worker can die between the move and the database commit.
    await expect(instance.markProcessed(file!)).resolves.toBeUndefined();
  });

  it('quarantines a failed file next to its reason', async () => {
    await withAdminClient((client) => client.put(Buffer.from('payload'), `${INBOX}/bad.csv`));

    const instance = track(source());
    const [file] = await instance.list();
    await instance.markFailed(file!, 'line 12: unparseable amount "1,2,3"');

    expect(await instance.list()).toEqual([]);
    const [moved, reason] = await withAdminClient(async (client) => [
      await client.get(`${INBOX}/failed/bad.csv`),
      await client.get(`${INBOX}/failed/bad.csv.error.txt`),
    ]);
    expect((moved as Buffer).toString('utf8')).toBe('payload');
    expect((reason as Buffer).toString('utf8')).toContain('line 12');
  });

  it('orders oldest first with a deterministic tie-break', async () => {
    await withAdminClient(async (client) => {
      await client.put(Buffer.from('1'), `${INBOX}/b.csv`);
      await client.put(Buffer.from('2'), `${INBOX}/a.csv`);
    });

    const listed = await track(source()).list();
    expect(listed).toHaveLength(2);
    for (let i = 1; i < listed.length; i++) {
      expect(listed[i]!.modifiedAt.getTime()).toBeGreaterThanOrEqual(
        listed[i - 1]!.modifiedAt.getTime(),
      );
    }
  });

  it('reuses one connection across many operations', async () => {
    await withAdminClient(async (client) => {
      for (let i = 0; i < 5; i++) await client.put(Buffer.from(`${i}`), `${INBOX}/f${i}.csv`);
    });

    const instance = track(source());
    const files = await instance.list();
    for (const file of files) expect((await instance.read(file)).length).toBe(1);
    expect(files).toHaveLength(5);
  });

  it('can be disposed twice without throwing', async () => {
    const instance = source();
    await instance.list();
    await instance.dispose();
    await expect(instance.dispose()).resolves.toBeUndefined();
  });

  it('reconnects after disposal', async () => {
    const instance = track(source());
    await instance.list();
    await instance.dispose();
    expect(await instance.list()).toEqual([]);
  });

  it('returns an empty list for a directory that does not exist', async () => {
    const missing = track(
      new SftpStatementSource({
        id: 'missing',
        host: HOST,
        port: PORT,
        username: USERNAME,
        credentials: { password: PASSWORD },
        directory: 'no-such-directory',
        hostKeyFingerprint: FINGERPRINT!,
      }),
    );
    expect(await missing.list()).toEqual([]);
  });
});
