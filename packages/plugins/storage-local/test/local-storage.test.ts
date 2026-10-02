import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BlobNotFoundError, BlobTooLargeError, InvalidBlobKeyError, type BlobStorage, type PluginContext } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin, { createLocalBlobStorage, DEFAULT_STORAGE_DIR, storageDirFromEnv } from '../src/index.ts';

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

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const collect = async (stream: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
};
const chunks = (data: Buffer, size: number): Readable => Readable.from((function* () { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); })());

/** Every regular file under the storage root, relative to it. */
async function files(): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

describe('put / get / head / delete', () => {
  it('stores a stream and reports key, size and sha256', async () => {
    const data = randomBytes(300_000);
    const result = await storage.put(chunks(data, 8192), { maxBytes: 1_000_000 });
    expect(result.size).toBe(data.length);
    expect(result.sha256).toBe(sha(data));
    expect(result.blobKey).toMatch(/^[0-9a-f]{32}$/);
    expect(await storage.head(result.blobKey)).toEqual({ size: data.length });
    expect((await collect(await storage.get(result.blobKey))).equals(data)).toBe(true);
    expect(await files()).toEqual([join(result.blobKey.slice(0, 2), result.blobKey)]);
  });

  it('stores an empty blob', async () => {
    const result = await storage.put(Readable.from([]), { maxBytes: 10 });
    expect(result).toMatchObject({ size: 0, sha256: sha(Buffer.alloc(0)) });
    expect(await storage.head(result.blobKey)).toEqual({ size: 0 });
    expect((await collect(await storage.get(result.blobKey))).length).toBe(0);
  });

  it('accepts any async iterable of bytes', async () => {
    async function* gen() {
      yield new TextEncoder().encode('hel');
      yield new TextEncoder().encode('lo');
    }
    const result = await storage.put(gen(), { maxBytes: 5 });
    expect((await collect(await storage.get(result.blobKey))).toString()).toBe('hello');
  });

  it('gives two uploads of the same bytes two blobs, so deleting one keeps the other', async () => {
    const a = await storage.put(Readable.from([Buffer.from('same')]), { maxBytes: 100 });
    const b = await storage.put(Readable.from([Buffer.from('same')]), { maxBytes: 100 });
    expect(a.blobKey).not.toBe(b.blobKey);
    expect(a.sha256).toBe(b.sha256);
    expect(await storage.delete(a.blobKey)).toBe(true);
    expect((await collect(await storage.get(b.blobKey))).toString()).toBe('same');
  });

  it('delete removes the blob and reports false the second time', async () => {
    const { blobKey } = await storage.put(Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    expect(await storage.delete(blobKey)).toBe(true);
    expect(await storage.delete(blobKey)).toBe(false);
    expect(await storage.head(blobKey)).toBeNull();
    await expect(storage.get(blobKey)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('answers a missing but well-formed key with null / false / not found', async () => {
    const key = 'a'.repeat(32);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.delete(key)).toBe(false);
    await expect(storage.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('works when the root does not exist yet and when it already has content', async () => {
    const first = await storage.put(Readable.from([Buffer.from('1')]), { maxBytes: 10 });
    const again = createLocalBlobStorage({ dir });
    expect(await again.head(first.blobKey)).toEqual({ size: 1 });
  });
});

describe('size cap', () => {
  it('accepts exactly maxBytes', async () => {
    const result = await storage.put(Readable.from([Buffer.alloc(100)]), { maxBytes: 100 });
    expect(result.size).toBe(100);
  });

  it('rejects maxBytes + 1 and leaves nothing behind', async () => {
    await expect(storage.put(Readable.from([Buffer.alloc(101)]), { maxBytes: 100 })).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(await files()).toEqual([]);
  });

  it('aborts mid-stream: stops reading, destroys the source, removes the partial file', async () => {
    let produced = 0;
    let finished = false;
    const source = Readable.from(
      (async function* () {
        try {
          for (;;) {
            produced++;
            yield Buffer.alloc(64 * 1024);
          }
        } finally {
          finished = true;
        }
      })(),
    );
    const err = await storage.put(source, { maxBytes: 200 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobTooLargeError);
    expect((err as BlobTooLargeError).maxBytes).toBe(200 * 1024);
    expect(produced).toBeLessThan(50); // an unbounded source was not drained
    expect(source.destroyed).toBe(true);
    expect(finished).toBe(true);
    expect(await files()).toEqual([]);
  });

  it('rejects maxBytes 0 for any content, accepts an empty blob', async () => {
    await expect(storage.put(Readable.from([Buffer.alloc(1)]), { maxBytes: 0 })).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(storage.put(Readable.from([]), { maxBytes: 0 })).resolves.toMatchObject({ size: 0 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid maxBytes (%s)', async (maxBytes) => {
    await expect(storage.put(Readable.from([Buffer.alloc(1)]), { maxBytes })).rejects.toBeInstanceOf(RangeError);
    expect(await files()).toEqual([]);
  });
});

describe('failures leave nothing behind', () => {
  it('a source that errors mid-stream', async () => {
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('connection reset');
      })(),
    );
    await expect(storage.put(source, { maxBytes: 100 })).rejects.toThrow('connection reset');
    expect(await files()).toEqual([]);
  });

  it('an upload that was aborted by the client', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.from('partial'));
    const pending = storage.put(source, { maxBytes: 100 });
    setTimeout(() => source.destroy(new Error('aborted')), 20);
    await expect(pending).rejects.toThrow('aborted');
    expect(await files()).toEqual([]);
  });
});

describe('keys cannot escape the root', () => {
  const bad = [
    '../outside',
    '..',
    '.',
    '',
    '/etc/passwd',
    '..%2f..%2fetc',
    'ab/' + 'c'.repeat(29),
    'ab\\' + 'c'.repeat(29),
    '0'.repeat(31),
    '0'.repeat(33),
    'A'.repeat(32),
    'g'.repeat(32),
    'a'.repeat(31) + '\0',
    'a'.repeat(32) + '\n',
    '../'.repeat(10) + 'a'.repeat(32),
    '.tmp',
  ];

  it.each(bad)('rejects %j on every method', async (key) => {
    await expect(storage.get(key)).rejects.toBeInstanceOf(InvalidBlobKeyError);
    await expect(storage.head(key)).rejects.toBeInstanceOf(InvalidBlobKeyError);
    await expect(storage.delete(key)).rejects.toBeInstanceOf(InvalidBlobKeyError);
  });

  it('rejects non-string keys', async () => {
    await expect(storage.get(undefined as unknown as string)).rejects.toBeInstanceOf(InvalidBlobKeyError);
    await expect(storage.delete({ toString: () => 'a'.repeat(32) } as unknown as string)).rejects.toBeInstanceOf(InvalidBlobKeyError);
  });

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

  it('issues keys that are always valid', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => storage.put(Readable.from([Buffer.from('k')]), { maxBytes: 10 })));
    for (const r of results) expect(r.blobKey).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('concurrent puts', () => {
  it('stores many uploads at once without mixing bytes', async () => {
    const payloads = Array.from({ length: 40 }, (_, i) => randomBytes(10_000 + i * 997));
    const results = await Promise.all(payloads.map((p) => storage.put(chunks(p, 1000 + 13), { maxBytes: 1_000_000 })));
    expect(new Set(results.map((r) => r.blobKey)).size).toBe(payloads.length);
    for (const [i, r] of results.entries()) {
      expect(r.sha256).toBe(sha(payloads[i] as Buffer));
      expect((await collect(await storage.get(r.blobKey))).equals(payloads[i] as Buffer)).toBe(true);
    }
    expect((await files()).length).toBe(payloads.length);
  });

  it('a failing upload does not disturb the ones next to it', async () => {
    const good = randomBytes(50_000);
    const [a, b, c] = await Promise.allSettled([
      storage.put(chunks(good, 4096), { maxBytes: 100_000 }),
      storage.put(chunks(randomBytes(200_000), 4096), { maxBytes: 100_000 }),
      storage.put(chunks(good, 4096), { maxBytes: 100_000 }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(c.status).toBe('fulfilled');
    expect((await files()).length).toBe(2);
  });

  it('reads a blob while others are written', async () => {
    const first = await storage.put(chunks(randomBytes(100_000), 4096), { maxBytes: 1_000_000 });
    const [read] = await Promise.all([
      collect(await storage.get(first.blobKey)),
      ...Array.from({ length: 10 }, () => storage.put(chunks(randomBytes(20_000), 2048), { maxBytes: 1_000_000 })),
    ]);
    expect(sha(read)).toBe(first.sha256);
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
