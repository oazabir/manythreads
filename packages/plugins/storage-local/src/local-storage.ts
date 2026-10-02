import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  InvalidBlobKeyError,
  type BlobHead,
  type BlobPutResult,
  type BlobStorage,
} from '@manythreads/sdk';

/** 128 random bits, lower-case hex. The only shape `get`, `head` and `delete` accept: no separators, no dots, no traversal. */
const KEY = /^[0-9a-f]{32}$/;

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
