import { createTestDatabase, dropTestDatabase, type TestDatabase, testPool } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from '../../src/outbox/listen.ts';

// PLAN D3 puts rate limits in memory and everything else in Postgres; NOTIFY is how the queue wakes up. One listener costs
// a pooled connection that is held for its life, so a server with N job workers, one outbox consumer and the realtime loop
// used to hold N+2 of them — and a system pool of ten ran out on a plugin's third queue, hanging the server's own boot
// (the next transaction waits for a connection that never comes back). These tests pin the sharing rule: one connection
// per pool and channel, every caller woken, and the connection gone when the last caller lets go.

let db: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = testPool({ connectionString: db.systemUrl, max: 10 });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

/**
 * A notification from a connection of its own, the way `enqueue` sends one. `NOTIFY` itself takes no parameters — a
 * channel is an identifier and the payload a literal — so the parameter goes through `pg_notify`, which does.
 */
async function notify(channel: string, payload: string): Promise<void> {
  const sender = testPool({ connectionString: db.systemUrl, max: 1 });
  try {
    await sender.query('SELECT pg_notify($1, $2)', [channel, payload]);
  } finally {
    await sender.end();
  }
}

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition never held');
};

describe('listen', () => {
  it('shares one connection between two listeners on the same channel, and wakes both', async () => {
    const one: string[] = [];
    const two: string[] = [];
    const releaseOne = await listen(pool, 'manythreads_jobs', (p) => one.push(p));
    const releaseTwo = await listen(pool, 'manythreads_jobs', (p) => two.push(p));
    expect(pool.totalCount).toBe(1);

    await notify('manythreads_jobs', 'a-plugin.queue');
    await waitFor(() => one.length === 1 && two.length === 1);
    expect(one).toEqual(['a-plugin.queue']);
    expect(two).toEqual(['a-plugin.queue']);

    // One letting go does not close the connection the other still holds.
    await releaseOne();
    expect(pool.totalCount).toBe(1);
    await notify('manythreads_jobs', 'another.queue');
    await waitFor(() => two.length === 2);
    expect(one).toHaveLength(1);

    await releaseTwo();
    await waitFor(() => pool.totalCount === 0);
  }, 30_000);

  it('keeps a channel per listener name, and releases the connection with the last one', async () => {
    const jobs: string[] = [];
    const outbox: string[] = [];
    const releaseJobs = await listen(pool, 'manythreads_jobs', (p) => jobs.push(p));
    const releaseOutbox = await listen(pool, 'manythreads_outbox', (p) => outbox.push(p));
    expect(pool.totalCount).toBe(2);

    await notify('manythreads_jobs', 'jobs-only');
    await notify('manythreads_outbox', 'outbox-only');
    await waitFor(() => jobs.length === 1 && outbox.length === 1);
    expect(jobs).toEqual(['jobs-only']);
    expect(outbox).toEqual(['outbox-only']);

    await releaseJobs();
    await releaseOutbox();
    await waitFor(() => pool.totalCount === 0);
  }, 30_000);

  it('rejects an unsafe channel name, and a release is idempotent', async () => {
    await expect(listen(pool, 'manythreads_jobs; DROP TABLE app.events', () => undefined)).rejects.toThrow(/Unsafe channel/);
    const release = await listen(pool, 'manythreads_jobs', () => undefined);
    await release();
    await release();
    await waitFor(() => pool.totalCount === 0);
  }, 30_000);

  it('lets a new listener join after the last one left', async () => {
    const first = await listen(pool, 'manythreads_jobs', () => undefined);
    await first();
    const seen: string[] = [];
    const second = await listen(pool, 'manythreads_jobs', (p) => seen.push(p));
    await notify('manythreads_jobs', 'after-restart');
    await waitFor(() => seen.length === 1);
    await second();
    await waitFor(() => pool.totalCount === 0);
  }, 30_000);
});
