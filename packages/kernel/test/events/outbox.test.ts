import { randomUUID } from 'node:crypto';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@majlis/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemPool, withSystem } from '../../src/db/index.ts';
import { claimOutbox, processedOnce, startConsumer } from '../../src/outbox/index.ts';

let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Pool;
const workspaceId = randomUUID();
const actorId = randomUUID();

/** Seeds `n` events with one outbox row for `subscriber` each, as owner (bulk). */
async function seed(subscriber: string, n: number): Promise<void> {
  await owner.query(
    `WITH ev AS (
       INSERT INTO app.events (workspace_id, actor_id, type, schema_version, payload)
       SELECT $1, $2, 'kernel.test.pinged', 1, jsonb_build_object('note', 'n' || g)
       FROM generate_series(1, $4::int) g RETURNING id)
     INSERT INTO app.outbox (event_id, subscriber) SELECT id, $3 FROM ev`,
    [workspaceId, actorId, subscriber, n],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  pool = createSystemPool(db.systemUrl, 12);
  owner = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 40_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
};

const pending = async (subscriber: string): Promise<number> =>
  Number(
    (
      await owner.query<{ n: string }>(
        'SELECT count(*) AS n FROM app.outbox WHERE subscriber = $1 AND done_at IS NULL AND dead_at IS NULL',
        [subscriber],
      )
    ).rows[0]?.n,
  );

describe('outbox consumers', () => {
  it('10,000 rows, 4 concurrent consumers: every row delivered at least once, none lost', async () => {
    await seed('bulk', 10_000);
    const seen = new Map<string, number>();
    const consumers = Array.from({ length: 4 }, () =>
      startConsumer({
        subscriber: 'bulk',
        pool,
        batch: 200,
        pollMs: 100,
        handler: (_event, meta) => {
          seen.set(meta.eventId, (seen.get(meta.eventId) ?? 0) + 1);
        },
      }),
    );
    await waitFor(async () => (await pending('bulk')) === 0);
    await Promise.all(consumers.map((c) => c.stop()));
    expect(seen.size).toBe(10_000);
    const done = await owner.query(`SELECT count(*) AS n FROM app.outbox WHERE subscriber = 'bulk' AND done_at IS NOT NULL`);
    expect(Number(done.rows[0].n)).toBe(10_000);
  }, 60_000);

  it('a crashed consumer (claim then abandon) loses nothing: rows are redelivered after the lease expires', async () => {
    await seed('crashy', 30);
    const abandoned = await claimOutbox('crashy', { batch: 20, leaseMs: 600, pool });
    expect(abandoned).toHaveLength(20);
    const seen = new Set<string>();
    const c = startConsumer({
      subscriber: 'crashy',
      pool,
      pollMs: 50,
      leaseMs: 600,
      handler: (_e, meta) => void seen.add(meta.eventId),
    });
    await waitFor(() => seen.size >= 10);
    await new Promise((r) => setTimeout(r, 150));
    expect(seen.size).toBeLessThan(30); // the abandoned 20 are still leased
    await waitFor(async () => (await pending('crashy')) === 0);
    await c.stop();
    expect(seen.size).toBe(30);
    const redelivered = await owner.query(
      `SELECT count(*) AS n FROM app.outbox WHERE subscriber = 'crashy' AND attempts = 2`,
    );
    expect(Number(redelivered.rows[0].n)).toBe(20);
  }, 30_000);

  it('failures back off, then dead-letter after maxAttempts', async () => {
    await seed('poison', 1);
    let calls = 0;
    const c = startConsumer({
      subscriber: 'poison',
      pool,
      pollMs: 30,
      maxAttempts: 3,
      backoffBaseMs: 20,
      handler: () => {
        calls += 1;
        throw new Error('nope');
      },
    });
    await waitFor(async () => {
      const r = await owner.query(`SELECT dead_at FROM app.outbox WHERE subscriber = 'poison'`);
      return r.rows[0]?.dead_at != null;
    });
    await c.stop();
    expect(calls).toBe(3);
    const row = await owner.query(`SELECT done_at, last_error FROM app.outbox WHERE subscriber = 'poison'`);
    expect(row.rows[0].done_at).toBeNull();
    expect(row.rows[0].last_error).toBe('nope');
  }, 20_000);

  it('processedOnce gives exactly-once effects across redelivery', async () => {
    await seed('once', 1);
    const eventId = (await owner.query(`SELECT event_id FROM app.outbox WHERE subscriber = 'once'`)).rows[0].event_id;
    const firsts = await Promise.all(
      Array.from({ length: 5 }, () => withSystem((tx) => processedOnce(tx, 'once', eventId), { pool })),
    );
    expect(firsts.filter(Boolean)).toHaveLength(1);
  });
});
