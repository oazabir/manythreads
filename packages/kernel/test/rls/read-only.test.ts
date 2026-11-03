import { randomUUID } from 'node:crypto';
import { ActorId, WorkspaceId } from '@manythreads/shared';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor } from '../../src/index.ts';

// PLAN P7-07: a route can ask for a READ ONLY transaction (`readOnly` on the route). The database then refuses every write in it, whoever asks.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const workspaceId = WorkspaceId.parse(randomUUID());
const person: Actor = { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId };

beforeAll(async () => {
  db = await createTestDatabase();
  appPool = createAppPool(db.appUrl, 2);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

const insertJob = (tx: { query: (sql: string) => Promise<unknown> }) => tx.query(`INSERT INTO app.jobs (queue, payload) VALUES ('readonly-probe', '{}')`);
const jobs = () => withSystem(async (tx) => (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.jobs WHERE queue = 'readonly-probe'`)).rows[0]?.n, { pool: sysPool });

describe('withActor readOnly', () => {
  it('reads as usual, with the actor settings in place', async () => {
    const seen = await withActor(person, async (tx) => (await tx.query<{ a: string }>(`SELECT current_setting('app.actor_id') AS a`)).rows[0]?.a, { pool: appPool, readOnly: true });
    expect(seen).toBe(person.id);
  });

  it('refuses a write, even by the system role, and leaves nothing behind', async () => {
    await expect(withSystem((tx) => insertJob(tx), { pool: sysPool, readOnly: true })).rejects.toMatchObject({ code: '25006' });
    await expect(
      withActor(
        person,
        async (tx) => {
          await tx.query('SELECT 1');
          await insertJob(tx);
        },
        { pool: appPool, readOnly: true },
      ),
    ).rejects.toBeDefined();
    expect(await jobs()).toBe('0');
  });

  it('is off by default: the same write works in an ordinary transaction', async () => {
    await withSystem((tx) => insertJob(tx), { pool: sysPool });
    expect(await jobs()).toBe('1');
  });
});

describe('withActor statementTimeoutMs', () => {
  it('cancels a statement that runs longer, with the database’s own error (57014)', async () => {
    await expect(withActor(person, (tx) => tx.query('SELECT pg_sleep(2)'), { pool: appPool, readOnly: true, statementTimeoutMs: 100 })).rejects.toMatchObject({ code: '57014' });
  });
  it('lets a quick statement through, and the limit ends with the transaction (the next one on the same connection has none)', async () => {
    const inside = await withActor(person, async (tx) => (await tx.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]?.t, { pool: appPool, statementTimeoutMs: 5000 });
    expect(inside).toBe('5s');
    const after = await withActor(person, async (tx) => (await tx.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]?.t, { pool: appPool });
    expect(after).not.toBe('5s');
  });
  it('is a whole number between 1 ms and ten minutes whatever it is given', async () => {
    const read = (ms: number) => withActor(person, async (tx) => (await tx.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]?.t, { pool: appPool, statementTimeoutMs: ms });
    expect(await read(0)).toBe('1ms');
    expect(await read(99_999_999)).toBe('10min');
    expect(await read(1500.9)).toBe('1500ms');
  });
});
