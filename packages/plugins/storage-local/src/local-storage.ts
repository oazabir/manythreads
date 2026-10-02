import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  InvalidBlobKeyError,
  type BlobHead,
  type BlobListItem,
  type BlobListPage,
  type BlobPutResult,
  type BlobStorage,
} from '@manythreads/sdk';

/** 128 random bits, lower-case hex. The only shape `get`, `head` and `delete` accept: no separators, no dots, no traversal. */
const KEY = /^[0-9a-f]{32}$/;
/** The instance marker file at the root of the store (not a shard directory, so `list` never sees it). */
export const MARKER_FILE = '.instance';

export interface LocalBlobStorageOptions {
  /** Root directory; relative paths resolve against the process's working directory at creation. */
  dir: string;
}

type Destroyable = { destroy?: (error?: Error) => unknown };

/**
 * Blobs as files under `<dir>/<key[0..2]>/<key>` with random keys (never content-derived: two uploads of the same bytes
 * are two blobs, so deleting one file row cannot break another). Uploads stream into `<dir>/.tmp` and move into place
 * with an atomic rename, so a reader never sees a partial blob.
 */
export function createLocalBlobStorage(options: LocalBlobStorageOptions): BlobStorage {
  const root = resolve(options.dir);
  const tmpDir = join(root, '.tmp');

  const pathOf = (blobKey: string): string => {
    if (typeof blobKey !== 'string' || !KEY.test(blobKey)) throw new InvalidBlobKeyError();
    return join(root, blobKey.slice(0, 2), blobKey);
  };

  return {
    id: 'local',

    async put(stream, { maxBytes }): Promise<BlobPutResult> {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative integer');
      await mkdir(tmpDir, { recursive: true });
      const blobKey = randomBytes(16).toString('hex');
      const tmpPath = join(tmpDir, `${blobKey}.part`);
      const hash = createHash('sha256');
      let size = 0;
      const file = await open(tmpPath, 'wx', 0o600);
      try {
        try {
          for await (const chunk of stream) {
            size += chunk.byteLength;
            if (size > maxBytes) throw new BlobTooLargeError(maxBytes);
            hash.update(chunk);
            await file.write(chunk);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        const finalPath = pathOf(blobKey);
        await mkdir(dirname(finalPath), { recursive: true });
        await rename(tmpPath, finalPath);
      } catch (err) {
        (stream as Destroyable).destroy?.();
        await rm(tmpPath, { force: true });
        throw err;
      }
      return { blobKey, size, sha256: hash.digest('hex') };
    },

    async get(blobKey) {
      const path = pathOf(blobKey);
      try {
        const info = await stat(path);
        if (!info.isFile()) throw new BlobNotFoundError();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError();
        throw err;
      }
      return createReadStream(path);
    },

    async delete(blobKey) {
      const path = pathOf(blobKey);
      try {
        await rm(path);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },

    async list({ after, limit }): Promise<BlobListPage> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be an integer from 1 to 1000');
      const items: BlobListItem[] = [];
      let shards: string[];
      try {
        shards = (await readdir(root)).filter((d) => /^[0-9a-f]{2}$/.test(d)).sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items, next: null };
        throw err;
      }
      const from = after === undefined ? '' : after;
      for (const shard of shards) {
        if (from !== '' && shard < from.slice(0, 2)) continue;
        const names = (await readdir(join(root, shard))).filter((n) => KEY.test(n) && n.startsWith(shard) && n > from).sort();
        for (const name of names) {
          // A blob can be deleted between the listing and the stat: skip it.
          const info = await stat(join(root, shard, name)).catch(() => null);
          if (!info?.isFile()) continue;
          items.push({ blobKey: name, size: info.size, modifiedAt: info.mtime });
          if (items.length === limit) return { items, next: name };
        }
      }
      return { items, next: null };
    },

    async getInstanceMarker(): Promise<string | null> {
      try {
        return (await readFile(join(root, MARKER_FILE), 'utf8')).trim();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async putInstanceMarker(id): Promise<boolean> {
      // Written complete to a temporary file, then linked into place: `link` fails with EEXIST when a marker exists, and a reader never sees half of one.
      await mkdir(tmpDir, { recursive: true });
      const tmpPath = join(tmpDir, `marker-${randomBytes(8).toString('hex')}.part`);
      await writeFile(tmpPath, `${id}\n`, { mode: 0o600, flag: 'wx' });
      try {
        await link(tmpPath, join(root, MARKER_FILE));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      } finally {
        await rm(tmpPath, { force: true });
      }
    },

    async head(blobKey): Promise<BlobHead | null> {
      const path = pathOf(blobKey);
      try {
        const info = await stat(path);
        return info.isFile() ? { size: info.size } : null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

export const DEFAULT_STORAGE_DIR = './data/blobs';

/** `MANYTHREADS_STORAGE_DIR`, else `./data/blobs`. */
export function storageDirFromEnv(env: Record<string, string | undefined>): string {
  const dir = env['MANYTHREADS_STORAGE_DIR']?.trim();
  return dir ? dir : DEFAULT_STORAGE_DIR;
}
