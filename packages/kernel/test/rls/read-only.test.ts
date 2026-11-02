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
