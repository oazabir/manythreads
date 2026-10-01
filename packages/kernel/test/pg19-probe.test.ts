import { createAppPool, getOneOrCreate, resetDoSelectProbe, supportsDoSelect, withSystem } from '../src/index.ts';
import type { Tx } from '../src/index.ts';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@majlis/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: TestDatabase;
let owner: pg.Client;
let appPool: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  appPool = createAppPool(db.appUrl, 4);
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

describe('Postgres 19 probe', () => {
  it('is Postgres 19', async () => {
    const r = await owner.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v");
    expect(r.rows[0]?.v).toBeGreaterThanOrEqual(190000);
  });

  it('uuidv7() works and is time-ordered', async () => {
    const r = await owner.query<{ a: string; b: string }>('SELECT uuidv7()::text AS a, uuidv7()::text AS b');
    const { a, b } = r.rows[0] ?? { a: '', b: '' };
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('INSERT ... ON CONFLICT ... DO SELECT RETURNING returns the existing row without writing', async () => {
    await owner.query('CREATE TABLE public.probe_dm (id uuid PRIMARY KEY DEFAULT uuidv7(), dm_key text UNIQUE, n int)');
    const first = await owner.query<{ id: string; xmin: string }>(
      "INSERT INTO public.probe_dm (dm_key, n) VALUES ('k', 1) RETURNING id, xmin::text AS xmin",
    );
    const again = await owner.query<{ id: string; n: number; xmin: string }>(
      "INSERT INTO public.probe_dm (dm_key, n) VALUES ('k', 2) ON CONFLICT (dm_key) DO SELECT RETURNING id, n, xmin::text AS xmin",
    );
    expect(again.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(again.rows[0]?.n).toBe(1); // not overwritten
    expect(again.rows[0]?.xmin).toBe(first.rows[0]?.xmin); // no new row version
    const stored = await owner.query<{ xmin: string }>("SELECT xmin::text AS xmin FROM public.probe_dm WHERE dm_key = 'k'");
    expect(stored.rows[0]?.xmin).toBe(first.rows[0]?.xmin);
  });

  it('has pg_trgm and vector', async () => {
    const r = await owner.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'vector') ORDER BY extname",
    );
    expect(r.rows.map((x) => x.extname)).toEqual(['pg_trgm', 'vector']);
    const sim = await owner.query<{ s: number; d: number }>(
      "SELECT similarity('majlis', 'majlist') AS s, ('[1,2,3]'::vector <-> '[1,2,4]'::vector) AS d",
    );
    expect(sim.rows[0]?.s).toBeGreaterThan(0.5);
    expect(sim.rows[0]?.d).toBeCloseTo(1);
  });

  // The crash-restart half (job_leases is empty after an unclean restart) is exercised in the jobs tests (P1-06,
  // acceptance criterion 7); here we only prove the table is UNLOGGED.
  it('job_leases is UNLOGGED while jobs and events are logged', async () => {
    const r = await owner.query<{ relname: string; relpersistence: string }>(
      `SELECT relname, relpersistence FROM pg_class
       WHERE relnamespace = 'app'::regnamespace AND relname IN ('job_leases', 'jobs', 'events', 'outbox')
       ORDER BY relname`,
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.relname, x.relpersistence]))).toEqual({
      events: 'p',
      job_leases: 'u',
      jobs: 'p',
      outbox: 'p',
    });
  });
});

describe('getOneOrCreate', () => {
  const link = {
    team_id: '00000000-0000-4000-8000-0000000000aa',
    src_type: 'message',
    src_id: '00000000-0000-4000-8000-0000000000b1',
    dst_type: 'task',
    dst_id: '00000000-0000-4000-8000-0000000000c1',
    kind: 'relates',
  };
  const conflict = ['src_type', 'src_id', 'dst_type', 'dst_id', 'kind'];

  it('creates once and returns the same row afterwards, writing nothing on a hit', async () => {
    const run = () =>
      withSystem(
        (tx) =>
          getOneOrCreate<{ id: string; xmin: string }>(tx, {
            table: 'entity_links',
            values: link,
            conflict,
            returning: ['id', 'xmin'],
          }),
        { pool: appPool },
      );
    const first = await run();
    const second = await run();
    expect(second.id).toBe(first.id);
    expect(second.xmin).toBe(first.xmin);
    expect(await withSystem((tx) => supportsDoSelect(tx), { pool: appPool })).toBe(true);
  });

  it('falls back to DO UPDATE SET key = EXCLUDED.key when DO SELECT is unsupported', async () => {
    resetDoSelectProbe();
    const seen: string[] = [];
    try {
      await withSystem(
        async (tx) => {
          const noDoSelect: Tx = {
            actor: tx.actor,
            query: (text, values) => {
              if (/DO SELECT/.test(text)) return Promise.reject(Object.assign(new Error('syntax error'), { code: '42601' }));
              seen.push(text);
              return tx.query(text, values);
            },
          };
          const input = { table: 'plugins', values: { name: 'fallback-probe', version: '1' }, conflict: ['name'] };
          const row = await getOneOrCreate<{ name: string; updated_at: Date }>(noDoSelect, input);
          expect(row.name).toBe('fallback-probe');
          const again = await getOneOrCreate<{ name: string; version: string }>(noDoSelect, {
            ...input,
            values: { name: 'fallback-probe', version: '2' },
          });
          expect(again).toMatchObject({ name: 'fallback-probe', version: '1' }); // existing row, not overwritten
        },
        { pool: appPool },
      );
    } finally {
      resetDoSelectProbe();
    }
    expect(seen.some((s) => /DO UPDATE SET "name" = EXCLUDED\."name"/.test(s))).toBe(true);
  });

  it('rejects unsafe identifiers', async () => {
    await expect(
      withSystem(
        (tx) => getOneOrCreate(tx, { table: 'entity_links; drop table x', values: { a: 1 }, conflict: ['a'] }),
        { pool: appPool },
      ),
    ).rejects.toThrow(/Unsafe SQL identifier/);
  });
});
