import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BlobNotFoundError, BlobTooLargeError, InvalidBlobKeyError, type BlobStorage, type PluginContext } from '@manythreads/sdk';
import { blobStorageContract } from '@manythreads/test-utils/blob-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin, { createLocalBlobStorage, DEFAULT_STORAGE_DIR, storageDirFromEnv } from '../src/index.ts';

// The shared provider contract (the same cases run against storage-s3), then what only a directory store has: its layout, `.tmp`, traversal on disk.
blobStorageContract('storage-local', async () => {
  const base = await mkdtemp(join(tmpdir(), 'manythreads-blobs-contract-'));
  return { storage: createLocalBlobStorage({ dir: join(base, 'blobs') }), cleanup: () => rm(base, { recursive: true, force: true }) };
});

let base: string;
let dir: string;
let storage: BlobStorage;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'manythreads-blobs-'));
  dir = join(base, 'blobs');
  storage = createLocalBlobStorage({ dir });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Every regular file under the storage root, relative to it. */
async function files(): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

describe('layout', () => {
  it('keeps a finished blob at <root>/<key[0..2]>/<key> and nothing else', async () => {
    const result = await storage.put(Readable.from([randomBytes(1000)]), { maxBytes: 10_000 });
    expect(await files()).toEqual([join(result.blobKey.slice(0, 2), result.blobKey)]);
  });

  it('works when the root does not exist yet and when it already has content', async () => {
    const first = await storage.put(Readable.from([Buffer.from('1')]), { maxBytes: 10 });
    const again = createLocalBlobStorage({ dir });
    expect(await again.head(first.blobKey)).toEqual({ size: 1 });
  });

  it('a refused or failed upload leaves no file and no .part behind', async () => {
    await expect(storage.put(Readable.from([Buffer.alloc(101)]), { maxBytes: 100 })).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(storage.put(Readable.from((async function* () { yield Buffer.from('x'); throw new Error('reset'); })()), { maxBytes: 100 })).rejects.toThrow('reset');
    expect(await files()).toEqual([]);
  });
});

describe('keys cannot escape the root', () => {
  it('never deletes or reads a file outside the root', async () => {
    const outside = join(base, 'outside');
    await writeFile(outside, 'secret');
    await storage.put(Readable.from([Buffer.from('x')]), { maxBytes: 10 }); // create the root
    await expect(storage.delete('../outside')).rejects.toBeInstanceOf(InvalidBlobKeyError);
    await expect(storage.get('../outside')).rejects.toBeInstanceOf(InvalidBlobKeyError);
    expect(await readFile(outside, 'utf8')).toBe('secret');
  });

  it('does not serve a directory under a valid-looking key', async () => {
    const key = 'b'.repeat(32);
    await mkdir(join(dir, 'bb', key), { recursive: true });
    expect(await storage.head(key)).toBeNull();
    await expect(storage.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});

describe('list', () => {
  it('is empty before the root exists, and ignores .tmp parts, directories and stray files', async () => {
    expect(await storage.list({ limit: 10 })).toEqual({ items: [], next: null });
    const { blobKey } = await storage.put(Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    await mkdir(join(dir, '.tmp'), { recursive: true });
    await writeFile(join(dir, '.tmp', `${'c'.repeat(32)}.part`), 'partial');
    await mkdir(join(dir, 'bb', 'b'.repeat(32)), { recursive: true });
    await writeFile(join(dir, 'bb', 'README'), 'not a blob');
    const page = await storage.list({ limit: 10 });
    expect(page.items.map((i) => i.blobKey)).toEqual([blobKey]);
  });

  it('reports the file modification time', async () => {
    const { blobKey } = await storage.put(Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    await utimes(join(dir, blobKey.slice(0, 2), blobKey), old, old);
    const [item] = (await storage.list({ limit: 10 })).items;
    expect(Math.abs((item?.modifiedAt.getTime() ?? 0) - old.getTime())).toBeLessThan(2000);
  });
});

describe('plugin', () => {
  it('registers a storage provider under id "local" on the configured directory', async () => {
    const registered: Array<{ kind: string; impl: BlobStorage }> = [];
    const ctx = { providers: { register: (kind: string, impl: BlobStorage) => registered.push({ kind, impl }) } } as unknown as PluginContext;
    const previous = process.env['MANYTHREADS_STORAGE_DIR'];
    process.env['MANYTHREADS_STORAGE_DIR'] = dir;
    try {
      await plugin.register(ctx);
    } finally {
      if (previous === undefined) delete process.env['MANYTHREADS_STORAGE_DIR'];
      else process.env['MANYTHREADS_STORAGE_DIR'] = previous;
    }
    expect(plugin.manifest).toMatchObject({ name: 'storage-local', extends: ['provider.storage'] });
    expect(registered).toHaveLength(1);
    expect(registered[0]?.kind).toBe('storage');
    expect(registered[0]?.impl.id).toBe('local');
    const { blobKey } = await registered[0]!.impl.put(Readable.from([Buffer.from('p')]), { maxBytes: 10 });
    expect(await files()).toEqual([join(blobKey.slice(0, 2), blobKey)]);
  });

  it('reads the directory from MANYTHREADS_STORAGE_DIR with a default', () => {
    expect(storageDirFromEnv({})).toBe(DEFAULT_STORAGE_DIR);
    expect(DEFAULT_STORAGE_DIR).toBe('./data/blobs');
    expect(storageDirFromEnv({ MANYTHREADS_STORAGE_DIR: '  ' })).toBe(DEFAULT_STORAGE_DIR);
    expect(storageDirFromEnv({ MANYTHREADS_STORAGE_DIR: '/var/lib/manythreads/blobs' })).toBe('/var/lib/manythreads/blobs');
  });
});
