import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { BlobNotFoundError, BlobTooLargeError, type BlobStorage, type PluginContext } from '@manythreads/sdk';
import { blobStorageContract } from '@manythreads/test-utils/blob-contract';
import { describe, expect, it } from 'vitest';
import plugin, { createS3BlobStorage, createS3Client, ensureBucket, s3ConfigFromEnv, type S3Config } from '../src/index.ts';

// Config parsing and the plugin run everywhere. The provider contract (the same suite storage-local runs) needs an S3 endpoint: MinIO from
// deploy/compose (`docker compose --profile s3 up -d minio`, `pnpm s3:up`) or the CI step. It runs when MANYTHREADS_TEST_S3=1.

describe('s3ConfigFromEnv', () => {
  const base = { MANYTHREADS_S3_BUCKET: 'blobs' };

  it('needs a bucket and defaults region, path style and prefix', () => {
    expect(() => s3ConfigFromEnv({})).toThrow(/MANYTHREADS_S3_BUCKET/);
    expect(s3ConfigFromEnv(base)).toEqual({ bucket: 'blobs', region: 'us-east-1', forcePathStyle: false, prefix: 'blobs/' });
  });

  it('reads endpoint, region, credentials and path style', () => {
    expect(
      s3ConfigFromEnv({
        ...base,
        MANYTHREADS_S3_ENDPOINT: ' http://minio:9000 ',
        MANYTHREADS_S3_REGION: 'eu-west-2',
        MANYTHREADS_S3_ACCESS_KEY: 'key',
        MANYTHREADS_S3_SECRET_KEY: 'secret',
        MANYTHREADS_S3_FORCE_PATH_STYLE: 'true',
        MANYTHREADS_S3_PREFIX: '/attachments',
      }),
    ).toEqual({
      endpoint: 'http://minio:9000',
      bucket: 'blobs',
      region: 'eu-west-2',
      accessKey: 'key',
      secretKey: 'secret',
      forcePathStyle: true,
      prefix: 'attachments/',
    });
    for (const yes of ['1', 'TRUE', 'yes', 'on']) expect(s3ConfigFromEnv({ ...base, MANYTHREADS_S3_FORCE_PATH_STYLE: yes }).forcePathStyle).toBe(true);
    for (const no of ['0', 'false', '', 'nope']) expect(s3ConfigFromEnv({ ...base, MANYTHREADS_S3_FORCE_PATH_STYLE: no }).forcePathStyle).toBe(false);
  });

  it('refuses half a credential pair (one key without the other)', () => {
    expect(() => s3ConfigFromEnv({ ...base, MANYTHREADS_S3_ACCESS_KEY: 'key' })).toThrow(/go together/);
    expect(() => s3ConfigFromEnv({ ...base, MANYTHREADS_S3_SECRET_KEY: 'secret' })).toThrow(/go together/);
  });
});

describe('plugin', () => {
  it('registers one storage provider with id "s3" from the environment, and refuses to load without a bucket', async () => {
    const registered: Array<{ kind: string; impl: BlobStorage }> = [];
    const ctx = { providers: { register: (kind: string, impl: BlobStorage) => registered.push({ kind, impl }) } } as unknown as PluginContext;
    const saved = { ...process.env };
    try {
      delete process.env['MANYTHREADS_S3_BUCKET'];
      await expect(Promise.resolve().then(() => plugin.register(ctx))).rejects.toThrow(/MANYTHREADS_S3_BUCKET/);
      process.env['MANYTHREADS_S3_BUCKET'] = 'b';
      process.env['MANYTHREADS_S3_ENDPOINT'] = 'http://127.0.0.1:1';
      process.env['MANYTHREADS_S3_ACCESS_KEY'] = 'k';
      process.env['MANYTHREADS_S3_SECRET_KEY'] = 's';
      await plugin.register(ctx);
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith('MANYTHREADS_S3_') && !(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(plugin.manifest).toMatchObject({ name: 'storage-s3', extends: ['provider.storage'] });
    expect(registered).toHaveLength(1);
    expect(registered[0]?.kind).toBe('storage');
    expect(registered[0]?.impl.id).toBe('s3');
  });

  it('rejects bad keys before touching the network', async () => {
    const client = createS3Client({ bucket: 'b', region: 'us-east-1', forcePathStyle: true, prefix: 'blobs/', endpoint: 'http://127.0.0.1:1', accessKey: 'k', secretKey: 's' });
    const storage = createS3BlobStorage({ client, bucket: 'b' });
    await expect(storage.get('../x')).rejects.toThrow('Invalid blob key');
    await expect(storage.list({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
  });
});

const live = process.env['MANYTHREADS_TEST_S3'] === '1';

function liveConfig(prefix: string): S3Config {
  return {
    endpoint: process.env['MANYTHREADS_TEST_S3_ENDPOINT'] ?? 'http://localhost:9000',
    bucket: process.env['MANYTHREADS_TEST_S3_BUCKET'] ?? 'manythreads-test',
    region: 'us-east-1',
    accessKey: process.env['MANYTHREADS_TEST_S3_ACCESS_KEY'] ?? 'manythreads',
    secretKey: process.env['MANYTHREADS_TEST_S3_SECRET_KEY'] ?? 'manythreads-secret',
    forcePathStyle: true,
    prefix,
  };
}

/** A store on a prefix of its own in the test bucket (created when missing), emptied by `cleanup`. */
async function liveTarget() {
  const config = liveConfig(`test-${randomBytes(6).toString('hex')}/`);
  const client = createS3Client(config);
  await ensureBucket(client, config.bucket);
  const storage = createS3BlobStorage({ client, bucket: config.bucket, prefix: config.prefix });
  const listAll = async () => {
    const keys: string[] = [];
    for (let token: string | undefined; ; ) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix, ...(token ? { ContinuationToken: token } : {}) }));
      keys.push(...(page.Contents ?? []).map((o) => o.Key as string));
      token = page.NextContinuationToken;
      if (!token) return keys;
    }
  };
  return {
    config,
    client,
    storage,
    listAll,
    async cleanup() {
      const keys = await listAll();
      for (let i = 0; i < keys.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
      }
    },
  };
}

describe.skipIf(!live)('storage-s3 against an S3 endpoint', () => {
  blobStorageContract('storage-s3', async () => {
    const t = await liveTarget();
    return { storage: t.storage, cleanup: t.cleanup };
  });

  it('keeps blobs under its prefix, one object per blob, and lists only keys it issued', async () => {
    const t = await liveTarget();
    try {
      const { blobKey } = await t.storage.put(Readable.from([Buffer.from('x')]), { maxBytes: 10 });
      // Something else under the prefix (an upload from a console, a marker) is not a blob of ours.
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await t.client.send(new PutObjectCommand({ Bucket: t.config.bucket, Key: `${t.config.prefix}README.txt`, Body: 'hi' }));
      expect(await t.listAll()).toEqual([`${t.config.prefix}${blobKey}`, `${t.config.prefix}README.txt`].sort());
      expect((await t.storage.list({ limit: 10 })).items.map((i) => i.blobKey)).toEqual([blobKey]);
    } finally {
      await t.cleanup();
    }
  });

  it('a refused upload leaves no object and no multipart upload in the bucket', async () => {
    const t = await liveTarget();
    try {
      await expect(t.storage.put(Readable.from([randomBytes(9 * 1024 * 1024), randomBytes(9 * 1024 * 1024)]), { maxBytes: 10 * 1024 * 1024 })).rejects.toBeInstanceOf(BlobTooLargeError);
      expect(await t.listAll()).toEqual([]);
      const open = await t.client.send(new ListMultipartUploadsCommand({ Bucket: t.config.bucket, Prefix: t.config.prefix }));
      expect(open.Uploads ?? []).toEqual([]);
      for (const u of open.Uploads ?? []) {
        await t.client.send(new AbortMultipartUploadCommand({ Bucket: t.config.bucket, Key: u.Key as string, UploadId: u.UploadId as string }));
      }
    } finally {
      await t.cleanup();
    }
  }, 60_000);

  it('answers not found for a key in another prefix of the same bucket (a store sees only its own prefix)', async () => {
    const a = await liveTarget();
    const b = await liveTarget();
    try {
      const { blobKey } = await a.storage.put(Readable.from([Buffer.from('mine')]), { maxBytes: 10 });
      expect(await b.storage.head(blobKey)).toBeNull();
      await expect(b.storage.get(blobKey)).rejects.toBeInstanceOf(BlobNotFoundError);
      expect(await b.storage.delete(blobKey)).toBe(false);
      expect(await a.storage.head(blobKey)).toEqual({ size: 4 });
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
