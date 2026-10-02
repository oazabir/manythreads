import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ChannelMessage, FileMeta, ListChannelFilesResponse } from '@manythreads/shared';
import type { BlobStorage, PluginTx } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalBlobStorage } from '../../storage-local/src/index.ts';
import { BLOB_GC_CRON, BLOB_GC_QUEUE, blobGcConfigFromEnv, runBlobGc, type BlobGcOptions } from '../src/index.ts';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from './world.ts';

// P4-00: the blob GC (rows of deleted-message files after 30 days, then every blob no row references and older than the grace period),
// and the decision that a file whose only messages were deleted is hidden at once.

const { nadia, rafi, omar } = personas;
const DAY = 86_400_000;

let w: FilesWorld;
let dev = '';
let store: BlobStorage;
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  store = createLocalBlobStorage({ dir: w.storageDir });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const upload = async (who: typeof nadia, name: string, body = `bytes of ${name}`): Promise<FileMeta> =>
  FileMeta.parse(ok(await w.upload(who, dev, body, { name, type: 'text/plain' }), 201));
const post = async (who: typeof nadia, text: string, attachments: string[]): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: text, threadRootId: null, attachments }), 201).id;
const removeMessage = async (who: typeof nadia, id: string): Promise<void> => {
  ok(await w.call(who, 'DELETE', `/api/channels/${dev}/messages/${id}`));
};
const names = async (who: typeof nadia): Promise<string[]> =>
  ListChannelFilesResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${dev}/files?limit=200`))).items.map((f) => f.name);
const status = async (who: typeof nadia, id: string): Promise<number> => (await w.download(who, id)).status;
const sys = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => w.system((tx) => fn(tx as unknown as PluginTx));
const blobKeyOf = async (fileId: string): Promise<string> => (await sys((tx) => tx.query<{ blob_key: string }>('SELECT blob_key FROM app.files WHERE id = $1', [fileId]))).rows[0]?.blob_key ?? '';
const age = (blobKey: string, ms: number): void => {
  const when = new Date(Date.now() - ms);
  utimesSync(join(w.storageDir, blobKey.slice(0, 2), blobKey), when, when);
};
const gc = (options: Partial<BlobGcOptions> = {}) =>
  sys((tx) => runBlobGc(tx, store, { dryRun: false, graceMs: DAY, orphanDays: 30, ...options }));
const putStray = async (text: string, ageMs: number): Promise<string> => {
  const { blobKey } = await store.put(Readable.from([Buffer.from(text)]), { maxBytes: 1000 });
  age(blobKey, ageMs);
  return blobKey;
};

describe('deleted-message files are hidden at once', () => {
  it('a file whose only message was deleted disappears for everyone (uploader included): list, bytes, card, metadata', async () => {
    const f = await upload(nadia, 'secret-plan.txt');
    const message = await post(nadia, 'the plan is attached', [f.id]);
    expect(await names(rafi)).toContain('secret-plan.txt');
    expect(await status(rafi, f.id)).toBe(200);
    await removeMessage(nadia, message);
    for (const who of [rafi, nadia, omar]) {
      expect(await names(who), 'list').not.toContain('secret-plan.txt');
      expect(await status(who, f.id), 'bytes').toBe(403);
      expect((await w.call(who, 'GET', `/api/files/${f.id}`)).status, 'metadata').toBe(403);
    }
    // The row and the bytes are still there for the system role: hidden is not deleted.
    expect(await blobKeyOf(f.id)).not.toBe('');
    expect(await store.head(await blobKeyOf(f.id))).not.toBeNull();
    expect(await sys((tx) => tx.query('SELECT 1 FROM app.files WHERE id = $1 AND orphaned_at IS NOT NULL', [f.id]))).toMatchObject({ rows: [{ '?column?': 1 }] });
  });

  it('a file another live message still lists stays visible until the last of them is deleted', async () => {
    const f = await upload(nadia, 'shared-twice.txt');
    const first = await post(nadia, 'first mention', [f.id]);
    const second = await post(nadia, 'second mention', [f.id]);
    await removeMessage(nadia, first);
    expect(await status(rafi, f.id)).toBe(200);
    const live = ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${second}`)));
    expect(live.attachments?.map((a) => a.name)).toEqual(['shared-twice.txt']);
    await removeMessage(nadia, second);
    expect(await status(rafi, f.id)).toBe(403);
  });

  it('a file that was never attached to a message is not touched when other messages are deleted', async () => {
    const loose = await upload(nadia, 'loose-file.txt');
    const other = await upload(nadia, 'attached.txt');
    await removeMessage(nadia, await post(nadia, 'x', [other.id]));
    expect(await names(rafi)).toContain('loose-file.txt');
    expect(await status(rafi, loose.id)).toBe(200);
  });
});

describe('blob GC', () => {
  it('deletes a blob no row references once it is past the grace period, keeps referenced and young ones, and reports what it did', async () => {
    const f = await upload(nadia, 'referenced.txt');
    age(await blobKeyOf(f.id), 5 * DAY);
    const old = await putStray('old stray', 3 * DAY);
    const young = await putStray('young stray', 2 * 3_600_000);
    const report = await gc();
    expect(report).toMatchObject({ dryRun: false, failed: 0, refused: null, next: null });
    expect(report.scanned).toBeGreaterThanOrEqual(3);
    expect(report.deleted).toBeGreaterThanOrEqual(1);
    expect(report.withinGrace).toBeGreaterThanOrEqual(1);
    expect(report.bytes).toBeGreaterThanOrEqual('old stray'.length);
    expect(await store.head(old)).toBeNull();
    expect(await store.head(young)).not.toBeNull();
    expect(await store.head(await blobKeyOf(f.id))).not.toBeNull();
    expect(await status(rafi, f.id)).toBe(200);
    await store.delete(young);
  });

  it('a dry run counts and deletes nothing', async () => {
    const stray = await putStray('dry stray', 4 * DAY);
    const report = await gc({ dryRun: true });
    expect(report).toMatchObject({ dryRun: true, deleted: 0 });
    expect(report.orphans).toBeGreaterThanOrEqual(1);
    expect(report.bytes).toBeGreaterThanOrEqual('dry stray'.length);
    expect(await store.head(stray)).not.toBeNull();
    expect((await gc()).deleted).toBeGreaterThanOrEqual(1);
    expect(await store.head(stray)).toBeNull();
  });

  it('collects the bytes of a row that went away without the delete route (a cascade, a purge)', async () => {
    const f = await upload(nadia, 'cascade.txt');
    const key = await blobKeyOf(f.id);
    age(key, 2 * DAY);
    await sys((tx) => tx.query('DELETE FROM app.files WHERE id = $1', [f.id]));
    expect(await store.head(key)).not.toBeNull();
    await gc();
    expect(await store.head(key)).toBeNull();
  });

  it('purges deleted-message files after the orphan period (the row first, then its bytes), and not before', async () => {
    const f = await upload(nadia, 'to-be-purged.txt');
    const key = await blobKeyOf(f.id);
    age(key, 40 * DAY);
    await removeMessage(nadia, await post(nadia, 'gone soon', [f.id]));
    const early = await gc({ dryRun: true });
    expect(early.purgedFiles).toBe(0);
    // 29 days in: still waiting.
    await sys((tx) => tx.query(`UPDATE app.files SET orphaned_at = now() - interval '29 days' WHERE id = $1`, [f.id]));
    expect((await gc()).purgedFiles).toBe(0);
    expect(await store.head(key)).not.toBeNull();
    // 31 days: the dry run says so, the real run deletes the row and, in the same sweep, the bytes.
    await sys((tx) => tx.query(`UPDATE app.files SET orphaned_at = now() - interval '31 days' WHERE id = $1`, [f.id]));
    const dry = await gc({ dryRun: true });
    expect(dry.purgedFiles).toBe(1);
    expect(await sys((tx) => tx.query('SELECT 1 FROM app.files WHERE id = $1', [f.id]))).toMatchObject({ rowCount: 1 });
    const real = await gc();
    expect(real.purgedFiles).toBe(1);
    expect(await sys((tx) => tx.query('SELECT 1 FROM app.files WHERE id = $1', [f.id]))).toMatchObject({ rowCount: 0 });
    expect(await store.head(key)).toBeNull();
  });

  it('walks a long store in pages and hands the rest to a follow-up run (cursor)', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) keys.push(await putStray(`paged ${i}`, 3 * DAY));
    let cursor: string | undefined;
    let deleted = 0;
    let runs = 0;
    do {
      const r = await gc({ pageSize: 2, maxScan: 3, ...(cursor !== undefined ? { cursor } : {}) });
      deleted += r.deleted;
      cursor = r.next ?? undefined;
      runs += 1;
    } while (cursor !== undefined && runs < 50);
    expect(runs).toBeGreaterThan(1);
    expect(deleted).toBeGreaterThanOrEqual(7);
    for (const k of keys) expect(await store.head(k)).toBeNull();
  });

  it('refuses to delete when the database has no files row at all (a server pointed at the wrong database)', async () => {
    // A second, empty database: the same store, no rows. Everything old looks unreferenced; the guard must stop it.
    const stray = await putStray('guarded', 3 * DAY);
    const marker = await store.getInstanceMarker!(); // the empty database is otherwise this store's: only the empty-database guard is under test
    const fake = {
      query: async (text: string) => {
        if (text.includes('count(*)')) return { rows: [{ n: 0 }] };
        if (text.startsWith('SELECT instance_id')) return { rows: [{ instance_id: marker }] };
        if (text.includes('EXISTS')) return { rows: [{ found: false }] };
        return { rows: [] };
      },
    } as unknown as PluginTx;
    const report = await runBlobGc(fake, store, { dryRun: false, graceMs: DAY, orphanDays: 30 });
    expect(report.refused).toMatch(/no files rows/);
    expect(report.deleted).toBe(0);
    expect(await store.head(stray)).not.toBeNull();
    const allowed = await runBlobGc(fake, store, { dryRun: false, graceMs: DAY, orphanDays: 30, allowEmpty: true });
    expect(allowed.refused).toBeNull();
    expect(await store.head(stray)).toBeNull();
  });
});

describe('instance marker (M4): the GC deletes only blobs of its own store', () => {
  const strayIn = async (s: BlobStorage, dir: string, text: string): Promise<string> => {
    const { blobKey } = await s.put(Readable.from([Buffer.from(text)]), { maxBytes: 1000 });
    const when = new Date(Date.now() - 3 * DAY);
    utimesSync(join(dir, blobKey.slice(0, 2), blobKey), when, when);
    return blobKey;
  };

  it('the first deleting run stamps the same id in the database and in the store; a second store with no marker gets the database\'s', async () => {
    const f = await upload(nadia, 'marker-anchor.txt'); // the database has a files row
    expect(f.id).toBeTruthy();
    await gc(); // stamps `store` (the earlier tests may have done so already)
    const dbId = (await sys((tx) => tx.query<{ instance_id: string }>('SELECT instance_id FROM app.blob_gc_instance'))).rows[0]?.instance_id;
    expect(dbId).toMatch(/^[0-9a-f]{32}$/);
    expect(await store.getInstanceMarker!()).toBe(dbId);
    const dir = mkdtempSync(join(tmpdir(), 'manythreads-gc-marker-'));
    const other = createLocalBlobStorage({ dir });
    const key = await strayIn(other, dir, 'in a fresh store');
    expect((await sys((tx) => runBlobGc(tx, other, { dryRun: false, graceMs: DAY, orphanDays: 30 }))).deleted).toBe(1);
    expect(await other.head(key)).toBeNull();
    expect(await other.getInstanceMarker!()).toBe(dbId);
  });

  it('refuses, and deletes nothing, when the store\'s marker is another deployment\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manythreads-gc-marker-'));
    const theirs = createLocalBlobStorage({ dir });
    await theirs.putInstanceMarker!('f'.repeat(32));
    const key = await strayIn(theirs, dir, 'belongs to the other deployment');
    const report = await sys((tx) => runBlobGc(tx, theirs, { dryRun: false, graceMs: DAY, orphanDays: 30 }));
    expect(report.deleted).toBe(0);
    expect(report.refused).toMatch(/marker differs/);
    expect(await theirs.head(key)).not.toBeNull();
    expect(await theirs.getInstanceMarker!()).toBe('f'.repeat(32)); // untouched
  });

  it('a provider that cannot keep a marker is never collected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manythreads-gc-marker-'));
    const real = createLocalBlobStorage({ dir });
    const key = await strayIn(real, dir, 'no marker support');
    const bare: BlobStorage = { ...real };
    delete bare.getInstanceMarker;
    delete bare.putInstanceMarker;
    const report = await sys((tx) => runBlobGc(tx, bare, { dryRun: false, graceMs: DAY, orphanDays: 30 }));
    expect(report).toMatchObject({ deleted: 0 });
    expect(report.refused).toMatch(/cannot keep an instance marker/);
    expect(await real.head(key)).not.toBeNull();
  });

  it('a database with no marker facing a store that has one is refused, unless the operator adopts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manythreads-gc-marker-'));
    const mine = createLocalBlobStorage({ dir });
    const key = await strayIn(mine, dir, 'restored database');
    const previous = (await sys((tx) => tx.query<{ instance_id: string }>('SELECT instance_id FROM app.blob_gc_instance'))).rows[0]!.instance_id;
    await sys((tx) => tx.query('DELETE FROM app.blob_gc_instance'));
    await mine.putInstanceMarker!('a'.repeat(32));
    const refused = await sys((tx) => runBlobGc(tx, mine, { dryRun: false, graceMs: DAY, orphanDays: 30 }));
    expect(refused.deleted).toBe(0);
    expect(refused.refused).toMatch(/another database/);
    expect(await mine.head(key)).not.toBeNull();
    const adopted = await sys((tx) => runBlobGc(tx, mine, { dryRun: false, graceMs: DAY, orphanDays: 30, adoptMarker: true }));
    expect(adopted.deleted).toBe(1);
    expect((await sys((tx) => tx.query<{ instance_id: string }>('SELECT instance_id FROM app.blob_gc_instance'))).rows[0]?.instance_id).toBe('a'.repeat(32));
    // put the original id back for the rest of the file
    await sys((tx) => tx.query('UPDATE app.blob_gc_instance SET instance_id = $1', [previous]));
  });

  it('a dry run never touches the marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manythreads-gc-marker-'));
    const s = createLocalBlobStorage({ dir });
    await strayIn(s, dir, 'dry');
    const report = await sys((tx) => runBlobGc(tx, s, { dryRun: true, graceMs: DAY, orphanDays: 30 }));
    expect(report.orphans).toBe(1);
    expect(await s.getInstanceMarker!()).toBeNull();
  });
});

describe('configuration', () => {
  it('reads mode, grace period and orphan period from the environment; a typo is a dry run, never a deletion', () => {
    // M4: nothing is deleted unless the deployment says `on` by name
    expect(blobGcConfigFromEnv({})).toEqual({ mode: 'dry-run', graceMs: DAY, orphanDays: 30, allowEmpty: false, adoptMarker: false });
    expect(blobGcConfigFromEnv({ MANYTHREADS_BLOB_GC: '' }).mode).toBe('dry-run');
    expect(blobGcConfigFromEnv({ MANYTHREADS_BLOB_GC: ' On ' }).mode).toBe('on');
    expect(blobGcConfigFromEnv({ MANYTHREADS_BLOB_GC: 'dry-run', MANYTHREADS_BLOB_GC_GRACE_HOURS: '48', MANYTHREADS_FILES_ORPHAN_DAYS: '7', MANYTHREADS_BLOB_GC_ALLOW_EMPTY: '1', MANYTHREADS_BLOB_GC_ADOPT_MARKER: '1' })).toEqual({
      mode: 'dry-run',
      graceMs: 2 * DAY,
      orphanDays: 7,
      allowEmpty: true,
      adoptMarker: true,
    });
    expect(blobGcConfigFromEnv({ MANYTHREADS_BLOB_GC: 'OFF' }).mode).toBe('off');
    expect(blobGcConfigFromEnv({ MANYTHREADS_BLOB_GC: 'yes please' }).mode).toBe('dry-run');
    // A grace period under an hour could delete an upload still in flight: ignored.
    expect(blobGcConfigFromEnv({ MANYTHREADS_BLOB_GC_GRACE_HOURS: '0' }).graceMs).toBe(DAY);
    expect(blobGcConfigFromEnv({ MANYTHREADS_FILES_ORPHAN_DAYS: 'abc' }).orphanDays).toBe(30);
  });
});

describe('the job', () => {
  it('is scheduled daily and runs through the worker: one metrics line in the log, deleting what the sweep finds', { timeout: 40_000 }, async () => {
    const schedules = await sys((tx) => tx.query<{ cron_expr: string; queue: string }>('SELECT cron_expr, queue FROM app.job_schedules WHERE name = $1', [BLOB_GC_QUEUE]));
    expect(schedules.rows).toEqual([{ cron_expr: BLOB_GC_CRON, queue: BLOB_GC_QUEUE }]);
    expect(BLOB_GC_CRON).toBe('17 3 * * *');

    process.env['MANYTHREADS_BLOB_GC'] = 'on'; // the default is a dry run; this deployment opts in by name
    const stray = await putStray('swept by the worker', 3 * DAY);
    const f = await upload(nadia, 'keeps-the-table-non-empty.txt');
    age(await blobKeyOf(f.id), 3 * DAY);
    await sys((tx) => tx.query(`SELECT app.enqueue_job($1, '{}'::jsonb, NULL, NULL)`, [BLOB_GC_QUEUE]));
    const deadline = Date.now() + 20_000;
    let message: string | undefined;
    while (Date.now() < deadline && message === undefined) {
      message = w.server.logs.map((l) => (JSON.parse(l) as { msg?: string }).msg ?? '').find((m) => m.startsWith(`${BLOB_GC_QUEUE} {`));
      if (message === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    expect(message, 'a metrics line in the server log').toBeDefined();
    const metrics = JSON.parse((message as string).slice(BLOB_GC_QUEUE.length + 1)) as Record<string, unknown>;
    expect(metrics).toMatchObject({ provider: 'local', dryRun: false, failed: 0, graceHours: 24 });
    expect(metrics['deleted']).toBeGreaterThanOrEqual(1);
    expect(await store.head(stray)).toBeNull();
    expect(await status(rafi, f.id)).toBe(200);
  });
});
