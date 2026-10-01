import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem } from '../../src/index.ts';
import { ActorId, WorkspaceId } from '@manythreads/shared';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const workspaceId = WorkspaceId.parse(randomUUID());
const actorId = ActorId.parse(randomUUID());

beforeAll(async () => {
  db = await createTestDatabase();
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 4);
  await withSystem(
    (tx) =>
      tx.query(
        `INSERT INTO events (workspace_id, actor_id, type, schema_version, payload)
         VALUES ($1, $2, 'kernel.test.pinged', 1, '{}')`,
        [workspaceId, actorId],
      ),
    { pool: sysPool },
  );
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

// Acceptance criterion 8: events is append-only for manythreads_app and manythreads_system.
describe('events is append-only for manythreads_app and manythreads_system', () => {
  const system = { kind: 'system', id: actorId, workspaceId } as const;

  it('INSERT works', async () => {
    const n = await withSystem((tx) => tx.query('SELECT 1 FROM events'), { pool: sysPool });
    expect(n.rowCount).toBe(1);
  });

  it('UPDATE fails with permission denied, even as the system actor', async () => {
    await expect(
      withActor(system, (tx) => tx.query("UPDATE events SET type = 'x'"), { pool: sysPool }),
    ).rejects.toThrow(/permission denied for table events/);
  });

  it('UPDATE and DELETE fail for an ordinary actor on the app pool too', async () => {
    const person = { kind: 'person', id: actorId, workspaceId } as const;
    await expect(withActor(person, (tx) => tx.query("UPDATE events SET type = 'x'"), { pool: appPool })).rejects.toThrow(
      /permission denied for table events/,
    );
    await expect(withActor(person, (tx) => tx.query('DELETE FROM events'), { pool: appPool })).rejects.toThrow(
      /permission denied for table events/,
    );
  });

  it('DELETE fails with permission denied, even as the system actor', async () => {
    await expect(withActor(system, (tx) => tx.query('DELETE FROM events'), { pool: sysPool })).rejects.toThrow(
      /permission denied for table events/,
    );
  });

  it('TRUNCATE fails too', async () => {
    await expect(withActor(system, (tx) => tx.query('TRUNCATE events'), { pool: sysPool })).rejects.toThrow(
      /permission denied for table events/,
    );
  });
});
