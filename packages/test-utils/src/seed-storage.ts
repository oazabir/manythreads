import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Tx } from '@manythreads/kernel';
import type { BlobStorage } from '@manythreads/sdk';
import { createLocalBlobStorage } from '../../plugins/storage-local/src/index.ts';

/** Which store the seed's attachments go to: what the server of the same environment uses. */
export type SeedStorageKind = 'local' | 's3';

export interface SeedStorageOptions {
  /** `local` (storage-local) or `s3` (storage-s3). Default: `MANYTHREADS_STORAGE` (like the server), else `local`. A ready provider is used as is. */
  storage?: SeedStorageKind | BlobStorage;
  /** storage-local's directory (default: `MANYTHREADS_STORAGE_DIR`, else `./data/blobs`). */
  storageDir?: string;
}

const isProvider = (v: SeedStorageOptions['storage']): v is BlobStorage => typeof v === 'object' && v !== null;

/** `MANYTHREADS_STORAGE` the way the server reads it (`local` when unset, anything else than `local`/`s3` is an error: a typo must not pick a store). */
export function seedStorageKindFromEnv(raw: string | undefined = process.env['MANYTHREADS_STORAGE']): SeedStorageKind {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === '' || v === 'local') return 'local';
  if (v === 's3') return 's3';
  throw new Error(`MANYTHREADS_STORAGE must be local or s3 (got "${raw}")`);
}

/**
 * The `storage` provider the seed writes attachment bytes through: the same code the server runs, so the blob lands where the server
 * reads it (a directory, or the bucket named by `MANYTHREADS_S3_*`) and its key is the provider's own. The S3 plugin (and the AWS SDK
 * behind it) is loaded only when the S3 store is chosen.
 */
export async function openSeedStorage(options: SeedStorageOptions = {}): Promise<BlobStorage> {
  if (isProvider(options.storage)) return options.storage;
  const kind = options.storage ?? seedStorageKindFromEnv();
  if (kind === 's3') {
    const s3 = await import('../../plugins/storage-s3/src/index.ts');
    const config = s3.s3ConfigFromEnv(process.env);
    return s3.createS3BlobStorage({ client: s3.createS3Client(config), bucket: config.bucket, prefix: config.prefix });
  }
  return createLocalBlobStorage({ dir: resolve(options.storageDir ?? process.env['MANYTHREADS_STORAGE_DIR'] ?? './data/blobs') });
}

export interface SeedAttachmentSpec {
  /** Fixed id of the `files` row. */
  id: string;
  workspaceId: string;
  channelId: string;
  /** `channels/<name>/`. */
  folderPath: string;
  name: string;
  mime: string;
  bytes: Buffer;
  uploaderActorId: string;
  createdAt: string;
}

export interface SeedAttachmentResult {
  size: number;
  sha256: string;
  /** What happened: the bytes and row were made, or the bytes were put back under an existing row, or nothing was needed. */
  action: 'created' | 'restored' | 'unchanged';
}

/**
 * One attachment of a channel folder, through the storage provider: `put` first (the provider chooses the key; the bytes exist before
 * the row does, as in an upload), then the `files` row with the fixed id. Idempotent: a row whose bytes the store still has is left alone;
 * a row whose bytes are gone (the volume or bucket was recreated) gets its bytes put again and its key updated. Runs in a system transaction.
 */
export async function putSeedAttachment(tx: Tx, storage: BlobStorage, spec: SeedAttachmentSpec): Promise<SeedAttachmentResult> {
  const have = await tx.query<{ blob_key: string; size: string; sha256: string }>('SELECT blob_key, size, sha256 FROM app.files WHERE id = $1', [spec.id]);
  const row = have.rows[0];
  if (row && (await storage.head(row.blob_key))) return { size: Number(row.size), sha256: row.sha256, action: 'unchanged' };
  const put = await storage.put(Readable.from([spec.bytes]), { maxBytes: spec.bytes.length + 1 });
  if (row) {
    await tx.query('UPDATE app.files SET blob_key = $2, size = $3, sha256 = $4 WHERE id = $1', [spec.id, put.blobKey, put.size, put.sha256]);
    return { size: put.size, sha256: put.sha256, action: 'restored' };
  }
  try {
    const res = await tx.query(
      `INSERT INTO app.files (id, workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
      [spec.id, spec.workspaceId, spec.channelId, spec.folderPath, spec.name, put.blobKey, put.size, spec.mime, put.sha256, spec.uploaderActorId, spec.createdAt],
    );
    // Conflict on the (channel, folder, name) key: a file of that name is already there (an upload by a person), which stays.
    if (res.rowCount === 0) {
      await storage.delete(put.blobKey);
      return { size: put.size, sha256: put.sha256, action: 'unchanged' };
    }
  } catch (err) {
    await storage.delete(put.blobKey).catch(() => undefined);
    throw err;
  }
  return { size: put.size, sha256: put.sha256, action: 'created' };
}
