import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  kernelMigrationSource,
  kernelMigrationsDir,
  type MigrationSource,
  readMigrationFiles,
  runMigrations,
  sha256,
} from '../src/index.ts';
import { createTestDatabase, dropTestDatabase, migrateTestDatabase, type TestDatabase } from '@majlis/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: TestDatabase;
const dirs: string[] = [];

async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'majlis-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

async function query<T extends pg.QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: db.ownerUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.end();
  }
}

// Same as runMigrations, serialised across test files because the majlis_app role is cluster-wide.
const run = (options: { connectionString: string; sources: readonly MigrationSource[] }) =>
  migrateTestDatabase({ ownerUrl: options.connectionString }, options.sources);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
}, 60_000);

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  if (db) await dropTestDatabase(db);
}, 60_000);

describe('migration runner', () => {
  it('applies the kernel files once and a second run applies none', async () => {
    const files = (await readdir(kernelMigrationsDir)).filter((f) => f.endsWith('.sql'));
    const options = { connectionString: db.ownerUrl, sources: [kernelMigrationSource] };
    expect(await run(options)).toBe(files.length);
    expect(await run(options)).toBe(0);
    const rows = await query<{ id: string; checksum: string }>('SELECT id, checksum FROM app.schema_migrations');
    expect(rows.map((r) => r.id)).toContain('kernel/0001_kernel.sql');
    const [kernel] = await readMigrationFiles([kernelMigrationSource]);
    expect(rows.find((r) => r.id === kernel?.id)?.checksum).toBe(kernel?.checksum);
    expect(kernel?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sets the majlis_app password so the role can log in', async () => {
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      const r = await app.query('SHOW search_path');
      expect(r.rows[0]?.search_path).toBe('app, public');
    } finally {
      await app.end();
    }
  });

  it('namespaces ids, so a plugin directory can reuse file numbers', async () => {
    const dir = await tempDir({ '0001_things.sql': 'CREATE TABLE public.mig_ns_probe (id int);' });
    const options = {
      connectionString: db.ownerUrl,
      sources: [kernelMigrationSource, { namespace: 'plug', dir }],
    };
    expect(await run(options)).toBe(1);
    const rows = await query<{ id: string }>("SELECT id FROM app.schema_migrations WHERE id LIKE 'plug/%'");
    expect(rows.map((r) => r.id)).toEqual(['plug/0001_things.sql']);
  });

  it('throws naming the file when an applied file was edited, and applies nothing new', async () => {
    const dir = await tempDir({ '0001_a.sql': 'CREATE TABLE public.mig_edit_a (id int);' });
    const options = { connectionString: db.ownerUrl, sources: [{ namespace: 'edit', dir }] };
    expect(await run(options)).toBe(1);
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE public.mig_edit_a (id int, extra int);');
    await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE public.mig_edit_b (id int);');
    await expect(run(options)).rejects.toThrow(/edit\/0001_a\.sql/);
    const b = await query('SELECT to_regclass(\'public.mig_edit_b\') AS t');
    expect(b[0]).toEqual({ t: null });
  });

  it('rejects down migrations by name', async () => {
    for (const name of ['0002_x.down.sql', '0003_down_x.sql']) {
      const dir = await tempDir({ '0001_x.sql': 'SELECT 1;', [name]: 'DROP TABLE nothing;' });
      await expect(
        runMigrations({ connectionString: db.ownerUrl, sources: [{ namespace: 'down', dir }], appPassword: null }),
      ).rejects.toThrow(new RegExp(`down/${name.replace('.', '\\.')}.*down`));
    }
    const rows = await query("SELECT 1 FROM app.schema_migrations WHERE id LIKE 'down/%'");
    expect(rows).toHaveLength(0);
  });

  it('rejects badly named files and duplicate numbers', async () => {
    const bad = await tempDir({ 'create_things.sql': 'SELECT 1;' });
    await expect(readMigrationFiles([{ namespace: 'bad', dir: bad }])).rejects.toThrow(/bad\/create_things\.sql/);
    const dup = await tempDir({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' });
    await expect(readMigrationFiles([{ namespace: 'dup', dir: dup }])).rejects.toThrow(/share the number/);
  });

  it('runs each file in its own transaction: a failure rolls back that file only', async () => {
    const dir = await tempDir({
      '0001_ok.sql': 'CREATE TABLE public.mig_tx_ok (id int);',
      '0002_bad.sql': 'CREATE TABLE public.mig_tx_bad (id int); SELECT 1/0;',
    });
    const options = { connectionString: db.ownerUrl, sources: [{ namespace: 'tx', dir }] };
    await expect(run(options)).rejects.toThrow(/tx\/0002_bad\.sql/);
    const t = await query("SELECT to_regclass('public.mig_tx_ok') AS ok, to_regclass('public.mig_tx_bad') AS bad");
    expect(t[0]).toEqual({ ok: 'mig_tx_ok', bad: null });
    const ids = await query<{ id: string }>("SELECT id FROM app.schema_migrations WHERE id LIKE 'tx/%'");
    expect(ids.map((r) => r.id)).toEqual(['tx/0001_ok.sql']);
  });

  it('two concurrent runners apply a file exactly once (advisory lock)', async () => {
    const dir = await tempDir({ '0001_c.sql': 'CREATE TABLE public.mig_lock_probe (id int);' });
    const options = { connectionString: db.ownerUrl, sources: [{ namespace: 'lock', dir }], appPassword: null };
    const counts = await Promise.all([runMigrations(options), runMigrations(options), runMigrations(options)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('hashes with sha256', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
