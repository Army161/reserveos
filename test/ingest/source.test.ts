import { mkdtemp, readFile, rm, writeFile, utimes, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contentHash,
  InMemoryStatementSource,
  LocalDirectorySource,
} from '../../src/ingest/source.js';

describe('contentHash', () => {
  it('is stable and sensitive to a single byte', () => {
    expect(contentHash(Buffer.from('abc'))).toBe(contentHash(Buffer.from('abc')));
    expect(contentHash(Buffer.from('abc'))).not.toBe(contentHash(Buffer.from('abd')));
    expect(contentHash(Buffer.from('abc'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('LocalDirectorySource', () => {
  let dir: string;
  let source: LocalDirectorySource;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reserveos-ingest-'));
    source = new LocalDirectorySource({ id: 'bny', directory: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty list for a directory that does not exist yet', async () => {
    const missing = new LocalDirectorySource({ id: 'x', directory: join(dir, 'nope') });
    expect(await missing.list()).toEqual([]);
  });

  it('lists only files with the configured extension', async () => {
    await writeFile(join(dir, 'a.csv'), 'x');
    await writeFile(join(dir, 'b.txt'), 'x');
    await writeFile(join(dir, 'c.CSV'), 'x');

    const names = (await source.list()).map((f) => f.name).sort();
    expect(names).toEqual(['a.csv', 'c.CSV']);
  });

  it('ignores subdirectories, so processed files are not re-listed', async () => {
    await writeFile(join(dir, 'a.csv'), 'x');
    await mkdir(join(dir, 'processed'), { recursive: true });
    await writeFile(join(dir, 'processed', 'old.csv'), 'x');

    expect((await source.list()).map((f) => f.name)).toEqual(['a.csv']);
  });

  it('orders oldest first, breaking mtime ties by name for a total order', async () => {
    await writeFile(join(dir, 'newer.csv'), 'x');
    await writeFile(join(dir, 'b-tie.csv'), 'x');
    await writeFile(join(dir, 'a-tie.csv'), 'x');

    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(join(dir, 'a-tie.csv'), old, old);
    await utimes(join(dir, 'b-tie.csv'), old, old);

    expect((await source.list()).map((f) => f.name)).toEqual(['a-tie.csv', 'b-tie.csv', 'newer.csv']);
  });

  it('reads exact bytes, preserving content that would break a naive text read', async () => {
    const content = 'coupon,"1,234.56"\r\nunicode,café\r\n';
    await writeFile(join(dir, 'a.csv'), content, 'utf8');

    const [file] = await source.list();
    const bytes = await source.read(file!);
    expect(bytes.toString('utf8')).toBe(content);
    expect(file!.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('moves a processed file out of the pending set but keeps the bytes', async () => {
    await writeFile(join(dir, 'a.csv'), 'payload');
    const [file] = await source.list();

    await source.markProcessed(file!);

    expect(await source.list()).toEqual([]);
    expect(await readFile(join(source.processedDir, 'a.csv'), 'utf8')).toBe('payload');
  });

  it('is idempotent when the same file is marked processed twice', async () => {
    await writeFile(join(dir, 'a.csv'), 'payload');
    const [file] = await source.list();

    await source.markProcessed(file!);
    // The worker can crash between the move and the database commit, so the
    // retry must not throw.
    await expect(source.markProcessed(file!)).resolves.toBeUndefined();
  });

  it('quarantines a failed file alongside the reason', async () => {
    await writeFile(join(dir, 'bad.csv'), 'payload');
    const [file] = await source.list();

    await source.markFailed(file!, 'row 12: unparseable amount "1,2,3"');

    expect(await source.list()).toEqual([]);
    expect(await readFile(join(source.failedDir, 'bad.csv'), 'utf8')).toBe('payload');
    expect(await readFile(join(source.failedDir, 'bad.csv.error.txt'), 'utf8')).toContain('row 12');
  });

  it('keeps failed and processed files separate', async () => {
    await writeFile(join(dir, 'good.csv'), 'a');
    await writeFile(join(dir, 'bad.csv'), 'b');
    const files = await source.list();

    await source.markProcessed(files.find((f) => f.name === 'good.csv')!);
    await source.markFailed(files.find((f) => f.name === 'bad.csv')!, 'nope');

    expect(existsSync(join(source.processedDir, 'good.csv'))).toBe(true);
    expect(existsSync(join(source.failedDir, 'bad.csv'))).toBe(true);
    expect(existsSync(join(source.processedDir, 'bad.csv'))).toBe(false);
  });
});

describe('InMemoryStatementSource', () => {
  let source: InMemoryStatementSource;

  beforeEach(() => {
    source = new InMemoryStatementSource();
    source.add('b.csv', 'second', new Date('2026-03-31T21:00:00Z'));
    source.add('a.csv', 'first', new Date('2026-03-31T20:00:00Z'));
  });

  it('lists oldest first', async () => {
    expect((await source.list()).map((f) => f.name)).toEqual(['a.csv', 'b.csv']);
  });

  it('reads content back', async () => {
    const [file] = await source.list();
    expect((await source.read(file!)).toString('utf8')).toBe('first');
  });

  it('removes processed files from the pending set and records them', async () => {
    const [file] = await source.list();
    await source.markProcessed(file!);

    expect((await source.list()).map((f) => f.name)).toEqual(['b.csv']);
    expect(source.processed).toEqual(['a.csv']);
  });

  it('records failures with their reason', async () => {
    const [file] = await source.list();
    await source.markFailed(file!, 'bad header');
    expect(source.failed).toEqual([{ name: 'a.csv', reason: 'bad header' }]);
  });

  it('throws when reading a file that is gone', async () => {
    const [file] = await source.list();
    await source.markProcessed(file!);
    await expect(source.read(file!)).rejects.toThrow(/no such statement/);
  });
});
