import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/**
 * Where custodian statements come from.
 *
 * Statements arrive by SFTP in production, but the transport is the least
 * interesting part and the hardest to test. Keeping it behind this interface
 * means the whole ingestion pipeline — parsing, normalization, dedupe, error
 * handling — is exercisable against a real filesystem, and an SFTP adapter
 * becomes a thin implementation of three methods rather than a prerequisite for
 * any of the work that actually carries risk.
 */

export interface StatementFile {
  /** Display name, e.g. `bny-positions-2026-03-31.csv`. */
  readonly name: string;
  /** Opaque locator, meaningful only to the source that produced it. */
  readonly locator: string;
  readonly sizeBytes: number;
  readonly modifiedAt: Date;
}

export interface StatementSource {
  /** Stable identifier for logs and error messages. */
  readonly id: string;
  /** Statements awaiting ingestion, oldest first. */
  list(): Promise<StatementFile[]>;
  read(file: StatementFile): Promise<Buffer>;
  /** Move out of the pending set. Must be idempotent. */
  markProcessed(file: StatementFile): Promise<void>;
  /** Set aside a file that could not be ingested, with the reason. */
  markFailed(file: StatementFile, reason: string): Promise<void>;
  /**
   * Release any transport resources. Idempotent, and a no-op for sources that
   * hold none. The caller owns the lifecycle: a worker processes many files per
   * run and should not pay a fresh SSH handshake for each one.
   */
  dispose(): Promise<void>;
}

/** SHA-256 of the raw bytes, used for both idempotency and evidence lineage. */
export function contentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface LocalDirectoryOptions {
  readonly id: string;
  readonly directory: string;
  /** Only files matching this are listed. Defaults to `.csv`, case-insensitive. */
  readonly extension?: string;
}

/**
 * Statements on the local filesystem.
 *
 * Processed and failed files move into sibling directories rather than being
 * deleted: when a figure on a certified report is questioned months later, the
 * exact bytes that produced it must still be recoverable.
 */
export class LocalDirectorySource implements StatementSource {
  readonly id: string;
  private readonly directory: string;
  private readonly extension: string;

  constructor(options: LocalDirectoryOptions) {
    this.id = options.id;
    this.directory = resolve(options.directory);
    this.extension = (options.extension ?? '.csv').toLowerCase();
  }

  get processedDir(): string {
    return join(this.directory, 'processed');
  }

  get failedDir(): string {
    return join(this.directory, 'failed');
  }

  async list(): Promise<StatementFile[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const files: StatementFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(this.extension)) continue;

      const locator = join(this.directory, entry.name);
      const info = await stat(locator);
      files.push({
        name: entry.name,
        locator,
        sizeBytes: info.size,
        // Millisecond precision: `mtime` carries sub-ms on some platforms and
        // this value is compared for ordering.
        modifiedAt: new Date(Math.floor(info.mtimeMs)),
      });
    }

    // Oldest first, then by name so the order is total and reproducible even
    // when two files share an mtime (common when a batch is copied in).
    return files.sort(
      (a, b) =>
        a.modifiedAt.getTime() - b.modifiedAt.getTime() || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  }

  async read(file: StatementFile): Promise<Buffer> {
    return readFile(file.locator);
  }

  async markProcessed(file: StatementFile): Promise<void> {
    await this.moveTo(file, this.processedDir);
  }

  async markFailed(file: StatementFile, reason: string): Promise<void> {
    await this.moveTo(file, this.failedDir);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(this.failedDir, `${basename(file.name)}.error.txt`), reason, 'utf8');
  }

  /** Nothing to release: the filesystem holds no connection. */
  async dispose(): Promise<void> {
    return undefined;
  }

  private async moveTo(file: StatementFile, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, file.name);
    try {
      await rename(file.locator, target);
    } catch (error) {
      // Already moved by an earlier run: markProcessed must be idempotent
      // because the worker may crash between the move and the DB commit.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** In-memory source for tests. */
export class InMemoryStatementSource implements StatementSource {
  readonly id: string;
  private readonly files = new Map<string, Buffer>();
  private readonly meta = new Map<string, Date>();
  readonly processed: string[] = [];
  readonly failed: { name: string; reason: string }[] = [];

  constructor(id = 'memory') {
    this.id = id;
  }

  add(name: string, content: string | Buffer, modifiedAt = new Date('2026-03-31T20:00:00.000Z')): void {
    this.files.set(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    this.meta.set(name, modifiedAt);
  }

  async list(): Promise<StatementFile[]> {
    return [...this.files.entries()]
      .map(([name, content]) => ({
        name,
        locator: name,
        sizeBytes: content.length,
        modifiedAt: this.meta.get(name)!,
      }))
      .sort(
        (a, b) =>
          a.modifiedAt.getTime() - b.modifiedAt.getTime() ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
  }

  async read(file: StatementFile): Promise<Buffer> {
    const content = this.files.get(file.locator);
    if (content === undefined) throw new Error(`no such statement: ${file.locator}`);
    return content;
  }

  async markProcessed(file: StatementFile): Promise<void> {
    this.files.delete(file.locator);
    this.processed.push(file.name);
  }

  async markFailed(file: StatementFile, reason: string): Promise<void> {
    this.files.delete(file.locator);
    this.failed.push({ name: file.name, reason });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  /** Lets a test assert the worker released its source. */
  disposed = false;
}
