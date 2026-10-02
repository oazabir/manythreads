import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobStorage } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openSeedStorage,
  ownerSql,
  personas,
  seedWorld,
  SEED_IDS,
  SEED_REPO_ATTACHMENTS,
  SEED_REPO_IDS,
  startTestServer,
  TEAM_IDS,
  type TestServer,
} from '../src/index.ts';

// Seed v4 (PLAN P4-13): the repositories of the three template teams and the attachments of #dev. The database comes from a started test
// server (its plugin migrations create the repo and files tables).
let server: TestServer;
let storageDir: string;
const sql = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> => ownerSql<T>(server.db.ownerUrl, text, params);
const as = (p: { actorId: string; workspaceId: string }): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

beforeAll(async () => {
  storageDir = mkdtempSync(join(tmpdir(), 'manythreads-seed4-blobs-'));
  process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
  process.env['MANYTHREADS_CLOCK'] = 'fixed';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_CLOCK'];
  if (server) await server.close();
  rmSync(storageDir, { recursive: true, force: true });
});

const entries = (teamId: string): Promise<{ path: string; size: number }[]> =>
  sql<{ path: string; size: number }>('SELECT path, size::int AS size FROM app.repo_entries WHERE team_id = $1 AND kind = $$file$$ ORDER BY path', [teamId]);

describe('seedWorld with repo (seed v4)', () => {
  it('fills every team repository through the writer, as the right people, and a second run changes nothing', async () => {
    const first = await seedWorld(server.db, { content: true, repo: true });
    expect(first.repo).toMatchObject({ skipped: null, teams: 3, attachments: 3 });
    expect(first.repo?.commits).toBeGreaterThanOrEqual(27);

    for (const [slug, teamId] of [['engineering', TEAM_IDS.Engineering], ['customer-support', TEAM_IDS['Customer support']], ['marketing', TEAM_IDS.Marketing]] as const) {
      const paths = (await entries(teamId)).map((e) => e.path);
      for (const want of ['TEAM.md', 'pages/runbook.md', 'pages/reports/signups.csv', 'pages/diagrams/dispatch.mmd', 'pages/weekly-digest.md', 'pages/changelog.md', 'apps/release-checklist/index.html']) {
        expect(paths, `${slug}: ${want}`).toContain(want);
      }
      // memory/ has two subfolders with content, bots/ has a placeholder bot with its three files
      expect(paths.some((p) => p.startsWith('memory/facts/') && p.endsWith('.md'))).toBe(true);
      expect(paths.some((p) => p.startsWith('memory/journal/') && p.endsWith('.md'))).toBe(true);
      const bot = paths.filter((p) => p.startsWith('bots/') && !p.endsWith('.gitkeep'));
      expect(bot.map((p) => p.split('/').pop()).sort()).toEqual(['BOT.md', 'lessons.md', 'memory.md']);

      // the runbook has history: two commits by two people (Customer support's by one), none by the system
      const runbook = await sql<{ author: string | null; message: string }>(
        `SELECT author_id AS author, message FROM app.repo_commits WHERE team_id = $1 AND paths @> ARRAY['pages/runbook.md'] ORDER BY committed_at, seq`,
        [teamId],
      );
      expect(runbook).toHaveLength(2);
      expect(runbook.every((r) => r.author !== null)).toBe(true);
      if (slug !== 'customer-support') expect(new Set(runbook.map((r) => r.author)).size).toBe(2);
    }

    // Authors are the people who would have done it
    const authorOf = async (teamId: string, path: string): Promise<string | null> =>
      (await sql<{ author: string | null }>(`SELECT author_id AS author FROM app.repo_commits WHERE team_id = $1 AND paths @> ARRAY[$2::text] ORDER BY committed_at DESC, seq DESC LIMIT 1`, [teamId, path]))[0]?.author ?? null;
    expect(await authorOf(TEAM_IDS.Marketing, 'pages/reports/signups.csv')).toBe(personas.tariq.actorId);
    expect(await authorOf(TEAM_IDS.Engineering, 'pages/runbook.md')).toBe(personas.nadia.actorId);
    expect(await authorOf(TEAM_IDS.Engineering, 'bots/coder/BOT.md')).toBe(personas.omar.actorId);
    expect(await authorOf(TEAM_IDS['Customer support'], 'pages/runbook.md')).toBe(personas.sameera.actorId);
    expect(await authorOf(TEAM_IDS.Engineering, 'memory/journal/2026-03-06.md')).toBeNull(); // the built-in routine, not a person

    // The app is a single file that loads the bridge and holds no network code
    const app = await sql<{ text_plain: string | null }>(`SELECT text_plain FROM app.repo_entries WHERE team_id = $1 AND path = 'apps/release-checklist/index.html'`, [TEAM_IDS.Engineering]);
    expect(app[0]?.text_plain).toContain('__manythreads.js');
    expect(app[0]?.text_plain).not.toMatch(/fetch\(|XMLHttpRequest|localStorage/);

    // A second run adds no commit, no row and no blob
    const counts = async (): Promise<string> =>
      JSON.stringify(await sql(`SELECT (SELECT count(*) FROM app.repo_commits)::int AS commits, (SELECT count(*) FROM app.repo_entries)::int AS entries,
        (SELECT count(*) FROM app.files)::int AS files, (SELECT string_agg(blob_key, ',' ORDER BY id) FROM app.files) AS keys, (SELECT string_agg(head_sha, ',' ORDER BY team_id) FROM app.repos) AS heads`));
    const before = await counts();
    const again = await seedWorld(server.db, { content: true, repo: true });
    expect(again.repo).toMatchObject({ skipped: null, commits: 0, attachments: 0 });
    expect(await counts()).toBe(before);
  }, 180_000);

  it('uploads a PDF, a PNG, an MP4 and an Office file to channels/dev/ that Nadia can download and Lena cannot', async () => {
    const files = await sql<{ id: string; name: string; mime: string; folder_path: string; size: number }>(
      `SELECT id, name, mime, folder_path, size::int AS size FROM app.files WHERE channel_id = $1 ORDER BY name`,
      [SEED_IDS.channels['engineering/dev']],
    );
    expect(files.map((f) => f.name)).toEqual(['canary-rollout.mp4', 'deploy-plan-v2.14.pdf', 'latency-before-after.png', 'release-notes-v2.14.docx']);
    expect(files.every((f) => f.folder_path === 'channels/dev/')).toBe(true);
    expect(files.find((f) => f.name === 'canary-rollout.mp4')?.mime).toBe('video/mp4');

    const magic: Record<string, (b: Buffer) => boolean> = {
      [SEED_IDS.file]: (b) => b.subarray(0, 5).toString() === '%PDF-',
      [SEED_REPO_IDS.png]: (b) => b.subarray(1, 4).toString() === 'PNG',
      [SEED_REPO_IDS.mp4]: (b) => b.subarray(4, 8).toString() === 'ftyp',
      [SEED_REPO_IDS.docx]: (b) => b.subarray(0, 2).toString() === 'PK',
    };
    for (const [id, check] of Object.entries(magic)) {
      const res = await fetch(`${server.url}/api/files/${id}/content`, { headers: as(personas.nadia) });
      expect(res.status, id).toBe(200);
      expect(check(Buffer.from(await res.arrayBuffer())), id).toBe(true);
      expect((await fetch(`${server.url}/api/files/${id}/content`, { headers: as(personas.lena) })).status, id).toBe(403);
    }
    expect(SEED_REPO_ATTACHMENTS.docx.name).toBe('release-notes-v2.14.docx');
  }, 60_000);

  it('keeps binaries out of git: no repo entry is anything but text', async () => {
    const bad = await sql(`SELECT path FROM app.repo_entries WHERE kind = 'file' AND path ~* '\\.(png|jpe?g|gif|mp4|pdf|docx?|xlsx?|pptx?|zip)$'`);
    expect(bad).toEqual([]);
  });
});

/** A storage provider that is not storage-local: bytes in a Map, keys of its own. The seed must go through it, not around it. */
function memoryStorage(): BlobStorage & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  let n = 0;
  const storage: BlobStorage = {
    id: 'memory',
    async put(stream) {
      const parts: Buffer[] = [];
      for await (const c of stream) parts.push(Buffer.from(c));
      const bytes = Buffer.concat(parts);
      n += 1;
      const blobKey = `${String(n).padStart(2, '0')}${'ab'.repeat(15)}`;
      blobs.set(blobKey, bytes);
      return { blobKey, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    get(key) {
      const b = blobs.get(key);
      if (!b) return Promise.reject(new Error('not found'));
      return Promise.resolve((async function* () { yield new Uint8Array(b); })());
    },
    delete: (key) => Promise.resolve(blobs.delete(key)),
    head: (key) => Promise.resolve(blobs.has(key) ? { size: blobs.get(key)?.length ?? 0 } : null),
    list: () => Promise.resolve({ items: [], next: null }),
  };
  return Object.assign(storage, { blobs });
}

describe('the seed attachments go through the storage provider (storage-local and storage-s3 alike)', () => {
  it('writes every attachment with the provider it is given, and puts the bytes back when the store was emptied', async () => {
    const other = await startTestServer();
    try {
      const memory = memoryStorage();
      const options = { content: true, repo: true, contentOptions: { storage: memory }, repoOptions: { storage: memory } } as const;
      const first = await seedWorld(other.db, options);
      expect(first.content).toMatchObject({ attachments: 1 });
      expect(first.repo).toMatchObject({ attachments: 3 });
      const keys = (await ownerSql<{ blob_key: string }>(other.db.ownerUrl, 'SELECT blob_key FROM app.files')).map((r) => r.blob_key);
      expect(keys).toHaveLength(4);
      for (const k of keys) expect(memory.blobs.has(k), k).toBe(true);
      // sha256 and size on the row are those of the stored bytes
      for (const r of await ownerSql<{ blob_key: string; size: string; sha256: string }>(other.db.ownerUrl, 'SELECT blob_key, size, sha256 FROM app.files')) {
        const bytes = memory.blobs.get(r.blob_key)!;
        expect(Number(r.size)).toBe(bytes.length);
        expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      // nothing was written to storage-local's directory
      expect(await openSeedStorage({ storage: 'local', storageDir: join(storageDir, 'unused') }).then((s) => s.list({ limit: 10 }))).toMatchObject({ items: [] });

      // a second run keeps the keys; an emptied store gets its bytes back under the same rows
      const again = await seedWorld(other.db, options);
      expect(again.repo).toMatchObject({ commits: 0, attachments: 0 });
      expect(memory.blobs.size).toBe(4);
      memory.blobs.clear();
      const restored = await seedWorld(other.db, options);
      expect(restored.repo).toMatchObject({ attachments: 3 });
      expect(restored.content).toMatchObject({ attachments: 1 });
      const after = (await ownerSql<{ blob_key: string }>(other.db.ownerUrl, 'SELECT blob_key FROM app.files')).map((r) => r.blob_key);
      expect(after).toHaveLength(4);
      for (const k of after) expect(memory.blobs.has(k), k).toBe(true);
      expect(await ownerSql(other.db.ownerUrl, 'SELECT 1 FROM app.files')).toHaveLength(4);
    } finally {
      await other.close();
    }
  }, 180_000);

  it('leaves the attachments out on request, and the repositories are still written', async () => {
    const bare = await startTestServer();
    try {
      const res = await seedWorld(bare.db, { content: true, repo: true, contentOptions: { attachment: false } });
      expect(res.repo).toMatchObject({ teams: 3, attachments: 0 });
      expect(await ownerSql(bare.db.ownerUrl, 'SELECT 1 FROM app.files')).toHaveLength(0);
      expect((await ownerSql(bare.db.ownerUrl, 'SELECT 1 FROM app.repo_commits')).length).toBeGreaterThan(20);
    } finally {
      await bare.close();
    }
  }, 180_000);

  it('writes the repositories alone when the conversations were not seeded (no #dev, no attachments)', async () => {
    const early = await startTestServer();
    try {
      const res = await seedWorld(early.db, { repo: true });
      expect(res.repo).toMatchObject({ skipped: null, teams: 3, attachments: 0 });
    } finally {
      await early.close();
    }
  }, 180_000);
});

// The same seed against a real S3-compatible store (MinIO from `pnpm s3:up`): `MANYTHREADS_TEST_S3=1`, like the storage-s3 suite.
describe.skipIf(process.env['MANYTHREADS_TEST_S3'] !== '1')('the seed attachments with storage-s3 (MinIO)', () => {
  it('uploads the four attachments to the bucket, the server of the same store serves them, and a re-run changes nothing', async () => {
    const s3 = await import('../../plugins/storage-s3/src/index.ts');
    const prefix = `seed-v4-${Date.now()}-${Math.random().toString(16).slice(2, 8)}/`;
    const env = {
      MANYTHREADS_S3_ENDPOINT: process.env['MANYTHREADS_TEST_S3_ENDPOINT'] ?? 'http://localhost:9000',
      MANYTHREADS_S3_BUCKET: process.env['MANYTHREADS_TEST_S3_BUCKET'] ?? 'manythreads-test',
      MANYTHREADS_S3_ACCESS_KEY: process.env['MANYTHREADS_TEST_S3_ACCESS_KEY'] ?? 'manythreads',
      MANYTHREADS_S3_SECRET_KEY: process.env['MANYTHREADS_TEST_S3_SECRET_KEY'] ?? 'manythreads-secret',
      MANYTHREADS_S3_FORCE_PATH_STYLE: 'true',
      MANYTHREADS_S3_PREFIX: prefix,
    };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const config = s3.s3ConfigFromEnv(process.env);
    const client = s3.createS3Client(config);
    await s3.ensureBucket(client, config.bucket);
    const store = s3.createS3BlobStorage({ client, bucket: config.bucket, prefix: config.prefix });
    // The server reads through storage-s3 too, so the download route is checked end to end.
    const other = await startTestServer({ storage: 's3' });
    try {
      const options = { content: true, repo: true, contentOptions: { storage: 's3' as const }, repoOptions: { storage: 's3' as const } };
      const first = await seedWorld(other.db, options);
      expect(first.content).toMatchObject({ attachments: 1 });
      expect(first.repo).toMatchObject({ attachments: 3 });
      const rows = await ownerSql<{ id: string; blob_key: string }>(other.db.ownerUrl, 'SELECT id, blob_key FROM app.files');
      expect(rows).toHaveLength(4);
      for (const r of rows) expect(await store.head(r.blob_key), r.blob_key).not.toBeNull();
      for (const id of [SEED_IDS.file, SEED_REPO_IDS.png, SEED_REPO_IDS.mp4, SEED_REPO_IDS.docx]) {
        const res = await fetch(`${other.url}/api/files/${id}/content`, { headers: as(personas.nadia) });
        expect(res.status, id).toBe(200);
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
      }
      const again = await seedWorld(other.db, options);
      expect(again.repo).toMatchObject({ commits: 0, attachments: 0 });
      expect(await ownerSql(other.db.ownerUrl, 'SELECT blob_key FROM app.files ORDER BY id')).toEqual(rows.sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ blob_key: r.blob_key })));
    } finally {
      await other.close();
      // empty our prefix
      let after: string | undefined;
      for (;;) {
        const page = await store.list({ limit: 1000, ...(after ? { after } : {}) });
        for (const item of page.items) await store.delete(item.blobKey);
        if (!page.next) break;
        after = page.next;
      }
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 180_000);
});
