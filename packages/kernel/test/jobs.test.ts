import { randomUUID } from 'node:crypto';
import { createTestDatabase, dropTestDatabase, type TestDatabase, testPool } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemPool, withSystem } from '../src/db/index.ts';
import { cronMatches, enqueue, latestSlot, parseCron, reapJobs, schedule, startWorker, tickSchedules } from '../src/jobs/index.ts';

let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = createSystemPool(db.systemUrl, 24);
  owner = testPool({ connectionString: db.ownerUrl, max: 2 });
  await owner.query(`CREATE TABLE public.job_effects (job_id uuid PRIMARY KEY, n int NOT NULL DEFAULT 1, worker text)`);
  await owner.query(`GRANT ALL ON public.job_effects TO manythreads_app, manythreads_system`);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 40_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for condition');
};
const states = async (queue: string): Promise<Record<string, number>> => {
  const r = await owner.query<{ state: string; n: string }>(
    'SELECT state, count(*) AS n FROM app.jobs WHERE queue = $1 GROUP BY state',
    [queue],
  );
  return Object.fromEntries(r.rows.map((x) => [x.state, Number(x.n)]));
};
const enqueueMany = (queue: string, n: number): Promise<void> =>
  withSystem(
    async (tx) => {
      for (let i = 0; i < n; i++) await enqueue(tx, queue, { i });
    },
    { pool },
  );

/** Idempotent effect: first run per job id inserts, repeats are no-ops (exactly once in effect). */
const applyEffect = (jobId: string, worker: string): Promise<unknown> =>
  withSystem((tx) => tx.query('INSERT INTO public.job_effects (job_id, worker) VALUES ($1, $2) ON CONFLICT DO NOTHING', [jobId, worker]), {
    pool,
  });

describe('cron parser', () => {
  it('parses fields and finds the latest slot', () => {
    expect(cronMatches(parseCron('*/15 9-10 * * 1,3'), new Date('2026-10-05T10:45:00Z'))).toBe(true); // Monday
    expect(cronMatches(parseCron('*/15 9-10 * * 1,3'), new Date('2026-10-06T10:45:00Z'))).toBe(false); // Tuesday
    expect(latestSlot('0 * * * *', new Date('2026-10-05T10:45:30Z'), new Date('2026-10-05T08:00:00Z'))?.toISOString()).toBe(
      '2026-10-05T10:00:00.000Z',
    );
    expect(latestSlot('0 12 * * *', new Date('2026-10-05T10:45:30Z'), new Date('2026-10-05T10:00:00Z'))).toBeNull();
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/minute/);
  });
});

describe('job queue', () => {
  it('UNLOGGED: job_leases is relpersistence u', async () => {
    const r = await owner.query(`SELECT relpersistence FROM pg_class WHERE oid = 'app.job_leases'::regclass`);
    expect(r.rows[0].relpersistence).toBe('u');
  });

  it('dedupe returns the existing job while ready/running, a new one after it is done', async () => {
    const q = 'dedupe';
    const [a, b] = await withSystem(
      async (tx) => [await enqueue(tx, q, { a: 1 }, { dedupeKey: 'k' }), await enqueue(tx, q, { a: 2 }, { dedupeKey: 'k' })],
      { pool },
    );
    expect(b.id).toBe(a.id);
    expect(b.payload).toEqual({ a: 1 });
    expect((await states(q))['ready']).toBe(1);
    await owner.query(`UPDATE app.jobs SET state = 'done' WHERE id = $1`, [a.id]);
    const c = await withSystem((tx) => enqueue(tx, q, {}, { dedupeKey: 'k' }), { pool });
    expect(c.id).not.toBe(a.id);
  });

  it('enqueue works from a non-system actor transaction', async () => {
    const { withActor } = await import('../src/db/index.ts');
    const job = await withActor(
      { kind: 'person', id: randomUUID() as never, workspaceId: randomUUID() as never },
      (tx) => enqueue(tx, 'actorq', { x: 1 }),
      { pool },
    );
    expect(job.state).toBe('ready');
  });

  it('50 jobs, 5 workers, one killed mid-job: reaper requeues, all complete, effect exactly once, no double hold', async () => {
    const q = 'work';
    await enqueueMany(q, 50);
    let victimStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => (victimStarted = r));
    const release: { fn: (() => void) | null } = { fn: null };
    const gate = new Promise<void>((r) => (release.fn = r));
    const holders = new Map<string, Set<string>>(); // job -> workers currently inside the handler
    let overlap = false;
    const runs = new Map<string, number>();

    const mk = (workerId: string, victim = false) =>
      startWorker({
        queue: q,
        workerId,
        pool,
        concurrency: 2,
        pollMs: 50,
        leaseMs: 600,
        reaperMs: 150,
        backoffBaseMs: 20,
        handler: async (_payload, ctx) => {
          // The halted victim is a zombie (its lease expired, its outcome is ignored): not a holder.
          const set = holders.get(ctx.jobId) ?? new Set<string>();
          if (!victim) {
            if (set.size > 0) overlap = true;
            set.add(workerId);
            holders.set(ctx.jobId, set);
          }
          runs.set(ctx.jobId, (runs.get(ctx.jobId) ?? 0) + 1);
          try {
            if (victim) {
              victimStarted?.();
              await gate; // hangs until after the worker is halted
              return;
            }
            await sleep(5);
            await applyEffect(ctx.jobId, workerId);
          } finally {
            if (!victim) set.delete(workerId);
          }
        },
      });

    const victim = mk('w-victim', true);
    await started;
    victim.halt(); // crash: no completion, leases left to expire
    const workers = ['w1', 'w2', 'w3', 'w4', 'w5'].map((w) => mk(w));
    await waitFor(async () => (await states(q))['done'] === 50);
    release.fn?.(); // the zombie handler finishes late; its outcome must be ignored
    await sleep(100);
    await Promise.all([victim.stop(), ...workers.map((w) => w.stop())]); // the zombie's connection is released before the pool ends

    expect(await states(q)).toEqual({ done: 50 });
    expect(overlap).toBe(false);
    const eff = await owner.query(`SELECT count(*) AS n, count(DISTINCT job_id) AS d FROM public.job_effects`);
    expect(Number(eff.rows[0].n)).toBe(Number(eff.rows[0].d));
    const effects = await owner.query(`SELECT count(*) AS n FROM public.job_effects WHERE job_id IN (SELECT id FROM app.jobs WHERE queue = $1)`, [q]);
    expect(Number(effects.rows[0].n)).toBe(50);
    const requeued = await owner.query(`SELECT count(*) AS n FROM app.jobs WHERE queue = $1 AND attempts > 1`, [q]);
    expect(Number(requeued.rows[0].n)).toBeGreaterThanOrEqual(1); // the victim's job was reaped and rerun
  }, 60_000);

  it('failing jobs back off then go dead', async () => {
    const q = 'failing';
    await enqueueMany(q, 1);
    let calls = 0;
    const w = startWorker({
      queue: q,
      workerId: 'wf',
      pool,
      pollMs: 30,
      maxAttempts: 3,
      backoffBaseMs: 20,
      leaseMs: 5000,
      handler: () => {
        calls++;
        throw new Error('bad');
      },
    });
    await waitFor(async () => (await states(q))['dead'] === 1);
    await w.stop();
    expect(calls).toBe(3);
  }, 20_000);

  it('UNLOGGED crash: truncating job_leases while jobs run -> reaper re-acquires, every job completes once in effect', async () => {
    const q = 'crash';
    await enqueueMany(q, 20);
    const first = new Set<string>();
    const w = startWorker({
      queue: q,
      workerId: 'wc',
      pool,
      concurrency: 5,
      pollMs: 40,
      leaseMs: 5000,
      reaperMs: 100,
      backoffBaseMs: 20,
      handler: async (_p, ctx) => {
        first.add(ctx.jobId);
        await sleep(300);
        await applyEffect(ctx.jobId, 'wc');
      },
    });
    await waitFor(async () => Number((await owner.query(`SELECT count(*) AS n FROM app.job_leases`)).rows[0].n) >= 5);
    await owner.query('TRUNCATE app.job_leases'); // what a crash restart leaves behind
    await waitFor(async () => (await states(q))['done'] === 20);
    await w.stop();
    expect(await states(q)).toEqual({ done: 20 });
    const effects = await owner.query(`SELECT count(*) AS n FROM public.job_effects WHERE job_id IN (SELECT id FROM app.jobs WHERE queue = $1)`, [q]);
    expect(Number(effects.rows[0].n)).toBe(20);
    expect(await reapJobs({ pool })).toBe(0);
  }, 60_000);
});

describe('cron ticker', () => {
  it('enqueues once per slot, even from concurrent tickers', async () => {
    await withSystem((tx) => schedule(tx, 'every-minute', '* * * * *', 'cronq', { tick: true }), { pool });
    const t1 = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 60_000 + 10_000);
    const counts = await Promise.all([tickSchedules({ now: t1, pool }), tickSchedules({ now: t1, pool }), tickSchedules({ now: t1, pool })]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await tickSchedules({ now: t1, pool })).toBe(0);
    expect(await tickSchedules({ now: new Date(t1.getTime() + 30_000), pool })).toBe(0); // same minute
    expect(await tickSchedules({ now: new Date(t1.getTime() + 60_000), pool })).toBe(1); // next slot
    const jobs = await owner.query(`SELECT dedupe_key FROM app.jobs WHERE queue = 'cronq' ORDER BY id`);
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[0].dedupe_key).toMatch(/^every-minute@/);
    expect(new Set(jobs.rows.map((r: { dedupe_key: string }) => r.dedupe_key)).size).toBe(2);
  });
});
