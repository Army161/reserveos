import { createHash } from 'node:crypto';
import SftpClient from 'ssh2-sftp-client';
import type { StatementFile, StatementSource } from './source.js';

/**
 * SFTP transport for custodian statements.
 *
 * Implements `StatementSource`, so everything downstream — parsing, mapping,
 * dedupe, transactional persistence — is unchanged and already tested against
 * the local-filesystem implementation. This file is only about moving bytes
 * safely.
 */

export interface SftpCredentials {
  /** Password auth. Prefer `privateKey`. */
  readonly password?: string;
  readonly privateKey?: string | Buffer;
  readonly passphrase?: string;
}

export interface SftpSourceOptions {
  readonly id: string;
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly credentials: SftpCredentials;
  /** Remote directory holding pending statements. */
  readonly directory: string;
  /**
   * Expected host key fingerprint, in `ssh-keygen -l` form:
   * `SHA256:yHOdBbRR1ENHALe1DbCu25dPAzSYvBtoniO4NRn0VyM`.
   *
   * Required, with no opt-out. `ssh2` accepts ANY host key when no verifier is
   * supplied, which makes a man-in-the-middle trivial — and the payload here is
   * a bank's complete reserve position. Pinning the key is the only thing that
   * makes the transport meaningfully authenticated, so it is a constructor
   * argument rather than an option someone can forget.
   */
  readonly hostKeyFingerprint: string;
  readonly extension?: string;
  readonly connectTimeoutMs?: number;
}

/** OpenSSH-style fingerprint: unpadded base64 of the SHA-256 of the key blob. */
export function hostKeyFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/**
 * Join remote path segments.
 *
 * Never `node:path.join` here: on Windows it emits backslashes, which an SFTP
 * server treats as part of the filename rather than a separator. The bug only
 * appears when the worker runs on Windows, so it would survive a Linux CI.
 */
export function remoteJoin(...segments: readonly string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment.replace(/\/+$/, '') : segment.replace(/^\/+|\/+$/g, '')))
    .filter((segment) => segment !== '')
    .join('/');
}

export class SftpHostKeyError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `SFTP host key mismatch: expected ${expected} but the server presented ${actual}. ` +
        'Refusing to transfer; the host key changed or the connection is being intercepted.',
    );
    this.name = 'SftpHostKeyError';
  }
}

export class SftpStatementSource implements StatementSource {
  readonly id: string;
  private readonly options: SftpSourceOptions;
  private readonly extension: string;
  private client: SftpClient | null = null;
  /** Set by the host verifier so a rejection can report what was presented. */
  private presentedFingerprint: string | null = null;

  constructor(options: SftpSourceOptions) {
    this.id = options.id;
    this.options = options;
    this.extension = (options.extension ?? '.csv').toLowerCase();
  }

  get processedDir(): string {
    return remoteJoin(this.options.directory, 'processed');
  }

  get failedDir(): string {
    return remoteJoin(this.options.directory, 'failed');
  }

  private async connect(): Promise<SftpClient> {
    if (this.client !== null) return this.client;

    const client = new SftpClient(this.id);
    const expected = this.options.hostKeyFingerprint;

    try {
      await client.connect({
        host: this.options.host,
        port: this.options.port ?? 22,
        username: this.options.username,
        ...(this.options.credentials.password === undefined
          ? {}
          : { password: this.options.credentials.password }),
        ...(this.options.credentials.privateKey === undefined
          ? {}
          : { privateKey: this.options.credentials.privateKey }),
        ...(this.options.credentials.passphrase === undefined
          ? {}
          : { passphrase: this.options.credentials.passphrase }),
        readyTimeout: this.options.connectTimeoutMs ?? 15_000,
        // Runs before authentication, so credentials are never offered to a host
        // that fails the check.
        hostVerifier: (key: Buffer): boolean => {
          const actual = hostKeyFingerprint(key);
          this.presentedFingerprint = actual;
          return timingSafeEqualString(actual, expected);
        },
      });
    } catch (error) {
      // ssh2 reports a rejected host key as a generic handshake failure, which
      // tells an operator nothing about the actual cause.
      if (this.presentedFingerprint !== null && this.presentedFingerprint !== expected) {
        const actual = this.presentedFingerprint;
        this.presentedFingerprint = null;
        throw new SftpHostKeyError(expected, actual);
      }
      throw error;
    }

    this.client = client;
    return client;
  }

  async list(): Promise<StatementFile[]> {
    const client = await this.connect();

    const exists = await client.exists(this.options.directory);
    if (exists === false) return [];

    const entries = await client.list(this.options.directory);

    return entries
      .filter((entry) => entry.type === '-' && entry.name.toLowerCase().endsWith(this.extension))
      .map((entry) => ({
        name: entry.name,
        locator: remoteJoin(this.options.directory, entry.name),
        sizeBytes: entry.size,
        modifiedAt: new Date(entry.modifyTime),
      }))
      .sort(
        (a, b) =>
          a.modifiedAt.getTime() - b.modifiedAt.getTime() ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
  }

  async read(file: StatementFile): Promise<Buffer> {
    const client = await this.connect();
    const content = await client.get(file.locator);

    // `get` returns a Buffer only when no destination is given; anything else
    // means the call was misused and the bytes are not what they appear.
    if (!Buffer.isBuffer(content)) {
      throw new TypeError(`expected a Buffer from SFTP get for ${file.locator}`);
    }
    return content;
  }

  async markProcessed(file: StatementFile): Promise<void> {
    await this.moveTo(file, this.processedDir);
  }

  async markFailed(file: StatementFile, reason: string): Promise<void> {
    await this.moveTo(file, this.failedDir);
    const client = await this.connect();
    await client.put(
      Buffer.from(reason, 'utf8'),
      remoteJoin(this.failedDir, `${file.name}.error.txt`),
    );
  }

  private async moveTo(file: StatementFile, targetDir: string): Promise<void> {
    const client = await this.connect();

    if ((await client.exists(targetDir)) === false) {
      await client.mkdir(targetDir, true);
    }

    const target = remoteJoin(targetDir, file.name);
    try {
      await client.rename(file.locator, target);
    } catch (error) {
      // The worker can crash between the move and the database commit, so a
      // retry must not fail on an already-moved file.
      if ((await client.exists(file.locator)) === false) return;
      throw error;
    }
  }

  /** Close the connection. The caller owns the lifecycle. */
  async dispose(): Promise<void> {
    if (this.client === null) return;
    const client = this.client;
    this.client = null;
    await client.end();
  }
}

/**
 * Compare fingerprints without leaking their contents through timing.
 *
 * A host key fingerprint is public, so this is belt and braces rather than a
 * strict requirement — but it costs nothing and avoids an early-exit compare
 * becoming a habit in code that also handles secrets.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
