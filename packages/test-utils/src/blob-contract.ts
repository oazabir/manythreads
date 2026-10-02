import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { BlobNotFoundError, BlobTooLargeError, InvalidBlobKeyError, type BlobStorage } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The `provider.storage` contract as a test suite: every blob store (storage-local, storage-s3, and any later provider) runs the SAME
 * cases, so "put with a size cap, get, head, delete, list, keys that cannot escape" means one thing. Import it from
 * `@manythreads/test-utils/blob-contract` (it pulls in vitest, so it is not part of the package index).
 *
 * `create` returns a store that starts EMPTY (a fresh directory, a fresh prefix in the bucket) and a `cleanup` that removes whatever is left.
 * Cases compare key sets from `list` instead of looking at a directory, so they hold for any backend.
 */
export interface BlobContractTarget {
  storage: BlobStorage;
  cleanup(): Promise<void>;
}

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** A stream of `data` in pieces of `size` bytes. */
export const chunked = (data: Buffer, size: number): Readable =>
  Readable.from(
    (function* () {
      for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
    })(),
  );

/** Every key the store lists, following `next` to the end. */
export async function allKeys(storage: BlobStorage, pageSize = 1000): Promise<string[]> {
  const keys: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await storage.list({ ...(after !== undefined ? { after } : {}), limit: pageSize });
    keys.push(...page.items.map((i) => i.blobKey));
    if (page.next === null) return keys;
    after = page.next;
  }
}

const BAD_KEYS = [
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

export function blobStorageContract(name: string, create: () => Promise<BlobContractTarget>, options: { timeoutMs?: number } = {}): void {
  describe(`BlobStorage contract: ${name}`, { timeout: options.timeoutMs ?? 30_000 }, () => {
    let target: BlobContractTarget;
    let storage: BlobStorage;
    beforeAll(async () => {
      target = await create();
      storage = target.storage;
    }, 60_000);
    afterAll(async () => {
      await target?.cleanup();
    }, 60_000);

    /** Runs `fn` and proves it stored nothing: the set of listed keys is the same before and after. */
    const leavesNothing = async (fn: () => Promise<unknown>): Promise<void> => {
      const before = await allKeys(storage);
      await fn();
      expect(await allKeys(storage)).toEqual(before);
    };

    describe('put / get / head / delete', () => {
      it('stores a stream and reports key, size and sha256', async () => {
        const data = randomBytes(300_000);
        const result = await storage.put(chunked(data, 8192), { maxBytes: 1_000_000 });
        expect(result.size).toBe(data.length);
        expect(result.sha256).toBe(sha(data));
        expect(result.blobKey).toMatch(/^[0-9a-f]{32}$/);
        expect(await storage.head(result.blobKey)).toEqual({ size: data.length });
        expect((await collect(await storage.get(result.blobKey))).equals(data)).toBe(true);
        expect(await allKeys(storage)).toContain(result.blobKey);
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

      it('streams a large body (several parts on an object store) byte for byte', async () => {
        const data = randomBytes(13 * 1024 * 1024 + 123);
        const result = await storage.put(chunked(data, 256 * 1024 + 7), { maxBytes: 20 * 1024 * 1024 });
        expect(result).toMatchObject({ size: data.length, sha256: sha(data) });
        expect(await storage.head(result.blobKey)).toEqual({ size: data.length });
        expect(sha(await collect(await storage.get(result.blobKey)))).toBe(sha(data));
        expect(await storage.delete(result.blobKey)).toBe(true);
      }, 120_000);

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
        expect(await allKeys(storage)).not.toContain(blobKey);
      });

      it('answers a missing but well-formed key with null / false / not found', async () => {
        const key = 'a'.repeat(32);
        expect(await storage.head(key)).toBeNull();
        expect(await storage.delete(key)).toBe(false);
        await expect(storage.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
      });
    });

    describe('size cap', () => {
      it('accepts exactly maxBytes', async () => {
        const result = await storage.put(Readable.from([Buffer.alloc(100)]), { maxBytes: 100 });
        expect(result.size).toBe(100);
      });

      it('rejects maxBytes + 1 and leaves nothing behind', async () => {
        await leavesNothing(async () => {
          await expect(storage.put(Readable.from([Buffer.alloc(101)]), { maxBytes: 100 })).rejects.toBeInstanceOf(BlobTooLargeError);
        });
      });

      it('aborts mid-stream: stops reading, destroys the source, stores nothing', async () => {
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
        await leavesNothing(async () => {
          const err = await storage.put(source, { maxBytes: 200 * 1024 }).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(BlobTooLargeError);
          expect((err as BlobTooLargeError).maxBytes).toBe(200 * 1024);
        });
        expect(produced).toBeLessThan(50); // an unbounded source was not drained
        expect(source.destroyed).toBe(true);
        expect(finished).toBe(true);
      });

      it('a body over the cap that already started a multipart upload leaves nothing behind either', async () => {
        await leavesNothing(async () => {
          await expect(storage.put(chunked(randomBytes(12 * 1024 * 1024), 512 * 1024), { maxBytes: 7 * 1024 * 1024 })).rejects.toBeInstanceOf(
            BlobTooLargeError,
          );
        });
      }, 120_000);

      it('rejects maxBytes 0 for any content, accepts an empty blob', async () => {
        await expect(storage.put(Readable.from([Buffer.alloc(1)]), { maxBytes: 0 })).rejects.toBeInstanceOf(BlobTooLargeError);
        await expect(storage.put(Readable.from([]), { maxBytes: 0 })).resolves.toMatchObject({ size: 0 });
      });

      it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid maxBytes (%s)', async (maxBytes) => {
        await leavesNothing(async () => {
          await expect(storage.put(Readable.from([Buffer.alloc(1)]), { maxBytes })).rejects.toBeInstanceOf(RangeError);
        });
      });
    });

    describe('failures leave nothing behind', () => {
      it('a source that errors mid-stream', async () => {
        await leavesNothing(async () => {
          const source = Readable.from(
            (async function* () {
              yield Buffer.from('partial');
              throw new Error('connection reset');
            })(),
          );
          await expect(storage.put(source, { maxBytes: 100 })).rejects.toThrow('connection reset');
        });
      });

      it('an upload that was aborted by the client', async () => {
        await leavesNothing(async () => {
          const source = new Readable({ read() {} });
          source.push(Buffer.from('partial'));
          const pending = storage.put(source, { maxBytes: 100 });
          setTimeout(() => source.destroy(new Error('aborted')), 20);
          await expect(pending).rejects.toThrow('aborted');
        });
      });
    });

    describe('keys cannot escape the store', () => {
      it.each(BAD_KEYS)('rejects %j on every method', async (key) => {
        await expect(storage.get(key)).rejects.toBeInstanceOf(InvalidBlobKeyError);
        await expect(storage.head(key)).rejects.toBeInstanceOf(InvalidBlobKeyError);
        await expect(storage.delete(key)).rejects.toBeInstanceOf(InvalidBlobKeyError);
      });

      it('rejects non-string keys', async () => {
        await expect(storage.get(undefined as unknown as string)).rejects.toBeInstanceOf(InvalidBlobKeyError);
        await expect(storage.delete({ toString: () => 'a'.repeat(32) } as unknown as string)).rejects.toBeInstanceOf(InvalidBlobKeyError);
      });

      it('issues keys that are always valid', async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => storage.put(Readable.from([Buffer.from('k')]), { maxBytes: 10 })));
        for (const r of results) expect(r.blobKey).toMatch(/^[0-9a-f]{32}$/);
        expect(new Set(results.map((r) => r.blobKey)).size).toBe(20);
      });
    });

    describe('concurrent puts', () => {
      it('stores many uploads at once without mixing bytes', async () => {
        const payloads = Array.from({ length: 40 }, (_, i) => randomBytes(10_000 + i * 997));
        const results = await Promise.all(payloads.map((p) => storage.put(chunked(p, 1000 + 13), { maxBytes: 1_000_000 })));
        expect(new Set(results.map((r) => r.blobKey)).size).toBe(payloads.length);
        for (const [i, r] of results.entries()) {
          expect(r.sha256).toBe(sha(payloads[i] as Buffer));
          expect((await collect(await storage.get(r.blobKey))).equals(payloads[i] as Buffer)).toBe(true);
        }
      });

      it('a failing upload does not disturb the ones next to it', async () => {
        const good = randomBytes(50_000);
        const before = new Set(await allKeys(storage));
        const [a, b, c] = await Promise.allSettled([
          storage.put(chunked(good, 4096), { maxBytes: 100_000 }),
          storage.put(chunked(randomBytes(200_000), 4096), { maxBytes: 100_000 }),
          storage.put(chunked(good, 4096), { maxBytes: 100_000 }),
        ]);
        expect(a.status).toBe('fulfilled');
        expect(b.status).toBe('rejected');
        expect(c.status).toBe('fulfilled');
        const added = (await allKeys(storage)).filter((k) => !before.has(k));
        expect(added.sort()).toEqual([(a as PromiseFulfilledResult<{ blobKey: string }>).value.blobKey, (c as PromiseFulfilledResult<{ blobKey: string }>).value.blobKey].sort());
      });

      it('reads a blob while others are written', async () => {
        const first = await storage.put(chunked(randomBytes(100_000), 4096), { maxBytes: 1_000_000 });
        const [read] = await Promise.all([
          collect(await storage.get(first.blobKey)),
          ...Array.from({ length: 10 }, () => storage.put(chunked(randomBytes(20_000), 2048), { maxBytes: 1_000_000 })),
        ]);
        expect(sha(read)).toBe(first.sha256);
      });
    });

    describe('list', () => {
      it('lists what was put (key, size, a recent modified time) and not what was deleted', async () => {
        const kept = await storage.put(Readable.from([Buffer.from('listed')]), { maxBytes: 100 });
        const gone = await storage.put(Readable.from([Buffer.from('gone')]), { maxBytes: 100 });
        await storage.delete(gone.blobKey);
        const items: Array<{ blobKey: string; size: number; modifiedAt: Date }> = [];
        let after: string | undefined;
        for (;;) {
          const page = await storage.list({ ...(after !== undefined ? { after } : {}), limit: 1000 });
          items.push(...page.items);
          if (page.next === null) break;
          after = page.next;
        }
        const mine = items.find((i) => i.blobKey === kept.blobKey);
        expect(mine).toMatchObject({ blobKey: kept.blobKey, size: 6 });
        expect(Math.abs(Date.now() - (mine?.modifiedAt.getTime() ?? 0))).toBeLessThan(5 * 60_000);
        expect(items.some((i) => i.blobKey === gone.blobKey)).toBe(false);
      });

      it('pages ascending by key, `after` is exclusive, and the pages add up to everything exactly once', async () => {
        for (let i = 0; i < 7; i++) await storage.put(Readable.from([Buffer.from(`p${i}`)]), { maxBytes: 100 });
        const everything = await allKeys(storage, 1000);
        expect(everything.length).toBeGreaterThanOrEqual(7);
        expect([...everything].sort()).toEqual(everything);
        expect(new Set(everything).size).toBe(everything.length);
        const paged = await allKeys(storage, 3);
        expect(paged).toEqual(everything);
        const first = await storage.list({ limit: 2 });
        expect(first.items.map((i) => i.blobKey)).toEqual(everything.slice(0, 2));
        const second = await storage.list({ after: first.items[1]?.blobKey ?? '', limit: 2 });
        expect(second.items.map((i) => i.blobKey)).toEqual(everything.slice(2, 4));
      });

      it.each([0, -1, 1001, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
        await expect(storage.list({ limit })).rejects.toBeInstanceOf(RangeError);
      });
    });
  });
}
