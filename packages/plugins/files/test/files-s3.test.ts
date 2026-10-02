import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createSystemPool, withSystem } from '@manythreads/kernel';
import { FileMeta } from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3BlobStorage, createS3Client, ensureBucket } from '../../storage-s3/src/index.ts';
import { runBlobGc } from '../src/index.ts';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from './world.ts';

// P4-13: the files plugin on the S3 provider (MinIO), end to end through the server: upload, download, the size cap, delete, deleted-message files, and the
// blob GC against the bucket. Runs when MANYTHREADS_TEST_S3=1 (see docs/plugins/storage-s3.md).

const live = process.env['MANYTHREADS_TEST_S3'] === '1';
const { nadia, rafi } = personas;
const DAY = 86_400_000;

describe.skipIf(!live)('files on storage-s3', () => {
  const prefix = `files-test-${randomBytes(6).toString('hex')}/`;
  const endpoint = process.env['MANYTHREADS_TEST_S3_ENDPOINT'] ?? 'http://localhost:9000';
  const bucket = process.env['MANYTHREADS_TEST_S3_BUCKET'] ?? 'manythreads-test';
  const accessKey = process.env['MANYTHREADS_TEST_S3_ACCESS_KEY'] ?? 'manythreads';
  const secretKey = process.env['MANYTHREADS_TEST_S3_SECRET_KEY'] ?? 'manythreads-secret';
  let w: FilesWorld;
  let dev = '';
  let store: ReturnType<typeof createS3BlobStorage>;
  const saved = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      MANYTHREADS_S3_ENDPOINT: endpoint,
      MANYTHREADS_S3_BUCKET: bucket,
      MANYTHREADS_S3_ACCESS_KEY: accessKey,
      MANYTHREADS_S3_SECRET_KEY: secretKey,
      MANYTHREADS_S3_FORCE_PATH_STYLE: 'true',
      MANYTHREADS_S3_PREFIX: prefix,
    });
    const client = createS3Client({ endpoint, bucket, region: 'us-east-1', accessKey, secretKey, forcePathStyle: true, prefix });
    await ensureBucket(client, bucket);
    store = createS3BlobStorage({ client, bucket, prefix });
    w = await createWorld({ storage: 's3' });
    await ensureChannels(w);
    dev = await w.channelId('engineering', 'dev');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
    for (const item of (await store?.list({ limit: 1000 }))?.items ?? []) await store.delete(item.blobKey);
    for (const k of Object.keys(process.env)) if (k.startsWith('MANYTHREADS_S3_') && !(k in saved)) delete process.env[k];
  });

  const ok = <T>(res: ApiResult, status = 200): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as T;
  };
  const upload = async (name: string, body: Uint8Array | string): Promise<FileMeta> => FileMeta.parse(ok(await w.upload(nadia, dev, body, { name, type: 'application/octet-stream' }), 201));
  const keys = async (): Promise<string[]> => (await store.list({ limit: 1000 })).items.map((i) => i.blobKey);

  it('uploads into the bucket, downloads the same bytes through the ACL, and a delete removes the object', async () => {
    const data = randomBytes(2 * 1024 * 1024 + 17);
    const f = await upload('big.bin', data);
    expect(f.size).toBe(data.length);
    expect((await keys()).length).toBe(1);
    const got = await w.download(rafi, f.id);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(data)).toBe(true);
    expect((await w.download(null, f.id)).status).toBe(401);
    ok(await w.call(nadia, 'DELETE', `/api/files/${f.id}`));
    expect(await keys()).toEqual([]);
    expect((await w.download(rafi, f.id)).status).toBe(403);
  });

  it('refuses a body over the cap with 413 and leaves no object behind (mid-stream, multipart)', async () => {
    process.env['MANYTHREADS_MAX_UPLOAD_BYTES'] = String(1024 * 1024);
    try {
      const res = await w.upload(nadia, dev, Readable.from([randomBytes(600 * 1024), randomBytes(600 * 1024)]), { name: 'toolarge.bin' });
      expect(res.status).toBe(413);
    } finally {
      delete process.env['MANYTHREADS_MAX_UPLOAD_BYTES'];
    }
    expect(await keys()).toEqual([]);
  });

  it('the blob GC collects a stray object and a deleted message\'s file (after its 30 days) in the bucket, and leaves live files', async () => {
    const live = await upload('live.txt', 'live bytes');
    const doomed = await upload('doomed.txt', 'doomed bytes');
    const message = ok<{ id: string }>(await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'x', threadRootId: null, attachments: [doomed.id] }), 201);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${message.id}`));
    expect((await w.download(rafi, doomed.id)).status).toBe(403);
    const stray = (await store.put(Readable.from([Buffer.from('stray')]), { maxBytes: 100 })).blobKey;

    const pool = createSystemPool(w.server.db.systemUrl, 2);
    const run = (opts: { dryRun: boolean; graceMs: number }) =>
      withSystem((tx) => runBlobGc(tx as unknown as PluginTx, store, { orphanDays: 30, ...opts }), { pool });
    try {
      // Everything is younger than the grace period: nothing goes.
      expect(await run({ dryRun: false, graceMs: DAY })).toMatchObject({ deleted: 0, purgedFiles: 0 });
      // Past the grace period (grace 0 stands for "a day later"), the stray goes; the hidden file still waits for its 30 days.
      const first = await run({ dryRun: false, graceMs: 0 });
      expect(first).toMatchObject({ deleted: 1, purgedFiles: 0, failed: 0 });
      expect(await store.head(stray)).toBeNull();
      await w.system((tx) => tx.query(`UPDATE app.files SET orphaned_at = now() - interval '31 days' WHERE id = $1`, [doomed.id]));
      expect(await run({ dryRun: true, graceMs: 0 })).toMatchObject({ purgedFiles: 1, deleted: 0 });
      expect(await run({ dryRun: false, graceMs: 0 })).toMatchObject({ purgedFiles: 1, deleted: 1 });
    } finally {
      await pool.end();
    }
    expect((await keys()).length).toBe(1);
    expect((await w.download(rafi, live.id)).bytes.toString()).toBe('live bytes');
  }, 60_000);
});
