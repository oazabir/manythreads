import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dropTestDatabase, ownerSql, testAdminUrl, testClient, type TestDatabase } from '../../../packages/test-utils/src/index.ts';
import { computeSnapshotHash, snapshotInputs } from '../src/hash.ts';
import { withFileLock } from '../src/lock.ts';
import { restoreSnapshot } from '../src/restore.ts';
import { dropSnapshot, saveSnapshotDatabase, snapshotDatabaseName, snapshotExists, snapshotFiles } from '../src/store.ts';

describe('snapshot hash', () => {
  it('changes with a migration and with a seed source, and not with an unrelated file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-hash-'));
    try {
      mkdirSync(join(root, 'packages', 'plugins', 'chat', 'migrations'), { recursive: true });
      mkdirSync(join(root, 'packages', 'test-utils', 'src'), { recursive: true });
      writeFileSync(join(root, 'packages', 'plugins', 'chat', 'migrations', '0001.sql'), 'CREATE TABLE a ();');
      writeFileSync(join(root, 'packages', 'test-utils', 'src', 'seed-content.ts'), 'export const a = 1;');
      const base = computeSnapshotHash(root);
      expect(computeSnapshotHash(root)).toBe(base);
      writeFileSync(join(root, 'packages', 'test-utils', 'src', 'unrelated.ts'), 'export const b = 2;');
      expect(computeSnapshotHash(root)).toBe(base);
      writeFileSync(join(root, 'packages', 'plugins', 'chat', 'migrations', '0001.sql'), 'CREATE TABLE a (id int);');
      const afterMigration = computeSnapshotHash(root);
      expect(afterMigration).not.toBe(base);
      writeFileSync(join(root, 'packages', 'test-utils', 'src', 'seed-content.ts'), 'export const a = 2;');
      expect(computeSnapshotHash(root)).not.toBe(afterMigration);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('covers every migrations folder of the real tree (kernel and plugins)', () => {
    const files = snapshotInputs().map((f) => f.replace(/\\/g, '/'));
    expect(files.some((f) => f.includes('/packages/kernel/migrations/0001_kernel.sql'))).toBe(true);
    expect(files.some((f) => /\/packages\/plugins\/channels\/migrations\/.+\.sql$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('/packages/test-utils/src/seed-content.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('/e2e/fixtures/stack-server.ts'))).toBe(true);
  });
});

describe('file lock', () => {
  it('lets one holder in at a time and takes over the lock of a process that is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-lock-'));
    const path = join(dir, 'x.lock');
    try {
      const order: string[] = [];
      const first = withFileLock(path, async () => {
        order.push('first:in');
        await new Promise((r) => setTimeout(r, 1500));
        order.push('first:out');
      });
      await new Promise((r) => setTimeout(r, 200));
      const second = withFileLock(path, async () => void order.push('second:in'));
      await Promise.all([first, second]);
      expect(order).toEqual(['first:in', 'first:out', 'second:in']);
      // a lock file naming a pid that does not exist
      writeFileSync(path, '2147483646');
      await expect(withFileLock(path, async () => 'ok', 3000)).resolves.toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('gives up with a message naming the file when the holder is alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-lock-'));
    const path = join(dir, 'y.lock');
    try {
      writeFileSync(path, String(process.pid));
      await expect(withFileLock(path, async () => 'never', 1200)).rejects.toThrow(/y\.lock/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// ---- restore, on a small fake snapshot kept under a hash of its own (the real day-1 and week-2 are never touched) ----
const FAKE_HASH = 'abcdef0123';
const FAKE_DB = snapshotDatabaseName('day-1', FAKE_HASH);
let cacheDir = '';
let previousCacheDir: string | undefined;
const made: TestDatabase[] = [];

async function newStackDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  made.push(db);
  return db;
}

beforeAll(async () => {
  previousCacheDir = process.env['MANYTHREADS_SNAPSHOT_DIR'];
  cacheDir = mkdtempSync(join(tmpdir(), 'mt-snap-cache-'));
  process.env['MANYTHREADS_SNAPSHOT_DIR'] = cacheDir;
  // the fake snapshot: a database with one table and row, kept as a template, and two tars
  const source = await createTestDatabase({ migrate: false });
  await ownerSql(source.ownerUrl, `CREATE TABLE public.marker (note text); INSERT INTO public.marker VALUES ('from the snapshot')`);
  await ownerSql(testAdminUrl(), `DROP DATABASE IF EXISTS "${FAKE_DB}" WITH (FORCE)`);
  await ownerSql(testAdminUrl(), `CREATE DATABASE "${FAKE_DB}" TEMPLATE "${source.name}"`);
  await ownerSql(testAdminUrl(), `ALTER DATABASE "${FAKE_DB}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  await dropTestDatabase(source);
  const files = snapshotFiles(FAKE_DB);
  for (const [tarFile, name, text] of [[files.repos, 'repos', 'a repository file'], [files.blobs, 'blobs', 'a stored file']] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'mt-snap-src-'));
    mkdirSync(join(dir, 'team'), { recursive: true });
    writeFileSync(join(dir, 'team', `${name}.txt`), text);
    execFileSync('tar', ['-cf', tarFile, '-C', dir, '.']);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

afterAll(async () => {
  await dropSnapshot(FAKE_DB).catch(() => undefined);
  for (const db of made) await dropTestDatabase(db).catch(() => undefined);
  if (previousCacheDir === undefined) delete process.env['MANYTHREADS_SNAPSHOT_DIR'];
  else process.env['MANYTHREADS_SNAPSHOT_DIR'] = previousCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
}, 120_000);

describe('restoreSnapshot', () => {
  it('replaces the stack database, under the same name, with a copy of the snapshot, and unpacks both folders', async () => {
    const db = await newStackDatabase();
    const dirs = mkdtempSync(join(tmpdir(), 'mt-restore-'));
    try {
      await ownerSql(db.ownerUrl, `CREATE TABLE public.leftover (x int)`);
      const result = await restoreSnapshot({ name: 'day-1', hash: FAKE_HASH, database: db, repoDir: join(dirs, 'repos'), storageDir: join(dirs, 'blobs'), autoBuild: false });
      expect(result.snapshotDatabase).toBe(FAKE_DB);
      expect(result.built).toBe(false);
      const rows = await ownerSql<{ note: string }>(db.ownerUrl, 'SELECT note FROM public.marker');
      expect(rows).toEqual([{ note: 'from the snapshot' }]);
      // what the empty database held is gone: it was replaced, not merged
      const leftover = await ownerSql<{ n: string }>(db.ownerUrl, `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = 'leftover'`);
      expect(leftover[0]?.n).toBe('0');
      expect(readFileSync(join(dirs, 'repos', 'team', 'repos.txt'), 'utf8')).toBe('a repository file');
      expect(readFileSync(join(dirs, 'blobs', 'team', 'blobs.txt'), 'utf8')).toBe('a stored file');
      // the app login finds its tables through the search path: a database's own role settings are not copied from a template
      const app = testClient({ connectionString: db.appUrl });
      await app.connect();
      try {
        const shown = await app.query<{ search_path: string }>('SHOW search_path');
        expect(shown.rows[0]?.search_path).toBe('app, public');
      } finally {
        await app.end();
      }
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  }, 60_000);

  it('takes a fraction of the 10 s budget, and two restores of one snapshot at once both succeed', async () => {
    const [a, b] = [await newStackDatabase(), await newStackDatabase()];
    const dirs = mkdtempSync(join(tmpdir(), 'mt-restore-'));
    try {
      const started = Date.now();
      const results = await Promise.all(
        [a, b].map((db, i) => restoreSnapshot({ name: 'day-1', hash: FAKE_HASH, database: db, repoDir: join(dirs, `r${i}`), storageDir: join(dirs, `b${i}`), autoBuild: false })),
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      for (const [i, db] of [a, b].entries()) {
        expect(results[i]?.millis).toBeLessThan(10_000);
        expect((await ownerSql<{ note: string }>(db.ownerUrl, 'SELECT note FROM public.marker'))[0]?.note).toBe('from the snapshot');
      }
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a snapshot that is not built or is out of date, names the command, and leaves the database it was given alone', async () => {
    const db = await newStackDatabase();
    await ownerSql(db.ownerUrl, `CREATE TABLE public.keep (x int); INSERT INTO public.keep VALUES (1)`);
    const dirs = mkdtempSync(join(tmpdir(), 'mt-restore-'));
    try {
      await expect(
        restoreSnapshot({ name: 'week-2', hash: '0000000000', database: db, repoDir: join(dirs, 'r'), storageDir: join(dirs, 'b'), autoBuild: false }),
      ).rejects.toThrow(/not built, or it is out of date.*snapshot build week-2/s);
      expect((await ownerSql<{ x: number }>(db.ownerUrl, 'SELECT x FROM public.keep'))[0]?.x).toBe(1);
      expect(await snapshotExists(snapshotDatabaseName('week-2', '0000000000'))).toBe(false);
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses an unknown name and a database that is not a throwaway test database', async () => {
    const db = await newStackDatabase();
    await expect(restoreSnapshot({ name: 'week-3', database: db, repoDir: '/tmp/x', storageDir: '/tmp/y' })).rejects.toThrow(/unknown snapshot/);
    await expect(
      restoreSnapshot({ name: 'day-1', hash: FAKE_HASH, database: { name: 'manythreads', ownerUrl: db.ownerUrl }, repoDir: '/tmp/x', storageDir: '/tmp/y', autoBuild: false }),
    ).rejects.toThrow(/refuses to replace manythreads/);
  });

  it('restores the real week-2 snapshot within 10 s when one is built (otherwise says so and passes)', async (ctx) => {
    const real = snapshotDatabaseName('week-2', computeSnapshotHash());
    // the real snapshot lives in the real cache folder, not the fake one this file set up
    const fakeDir = process.env['MANYTHREADS_SNAPSHOT_DIR'];
    delete process.env['MANYTHREADS_SNAPSHOT_DIR'];
    try {
      if (!(await snapshotExists(real))) return void ctx.skip();
      const db = await newStackDatabase();
      const dirs = mkdtempSync(join(tmpdir(), 'mt-restore-'));
      try {
        const started = Date.now();
        await restoreSnapshot({ name: 'week-2', database: db, repoDir: join(dirs, 'r'), storageDir: join(dirs, 'b'), autoBuild: false });
        expect(Date.now() - started).toBeLessThan(10_000);
        const channels = await ownerSql<{ n: string }>(db.ownerUrl, 'SELECT count(*)::text AS n FROM app.channels');
        expect(Number(channels[0]?.n)).toBeGreaterThan(10);
      } finally {
        rmSync(dirs, { recursive: true, force: true });
      }
    } finally {
      if (fakeDir !== undefined) process.env['MANYTHREADS_SNAPSHOT_DIR'] = fakeDir;
    }
  }, 60_000);
});

describe('saveSnapshotDatabase', () => {
  it('saves a snapshot and replaces one that is already there (snapshot build --force on a current one)', async () => {
    const name = snapshotDatabaseName('week-2', 'fedcba9876');
    const first = await createTestDatabase({ migrate: false });
    const second = await createTestDatabase({ migrate: false });
    made.push(first, second);
    try {
      await ownerSql(first.ownerUrl, `CREATE TABLE public.marker (note text); INSERT INTO public.marker VALUES ('first')`);
      await ownerSql(second.ownerUrl, `CREATE TABLE public.marker (note text); INSERT INTO public.marker VALUES ('second')`);
      await saveSnapshotDatabase(name, first.name);
      // the saved copy is a template: a plain DROP DATABASE is refused, which is what made the rebuild fail
      await expect(ownerSql(testAdminUrl(), `DROP DATABASE "${name}"`)).rejects.toThrow(/template database/);
      await saveSnapshotDatabase(name, second.name);
      const copy = await newStackDatabase();
      await ownerSql(testAdminUrl(), `DROP DATABASE "${copy.name}" WITH (FORCE)`);
      await ownerSql(testAdminUrl(), `CREATE DATABASE "${copy.name}" TEMPLATE "${name}"`);
      expect((await ownerSql<{ note: string }>(copy.ownerUrl, 'SELECT note FROM public.marker'))[0]?.note).toBe('second');
    } finally {
      await dropSnapshot(name).catch(() => undefined);
    }
  }, 60_000);
});
