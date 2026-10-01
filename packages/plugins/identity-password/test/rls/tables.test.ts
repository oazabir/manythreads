import { fileURLToPath } from 'node:url';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor } from '@manythreads/kernel';
import { ActorId, WorkspaceId } from '@manythreads/shared';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@manythreads/test-utils';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The tables behind sign-in hold token hashes: only the system role may touch them (a person or bot transaction has no
// privilege at all, not even to count rows).

let db: TestDatabase;
let app: pg.Pool;
let sys: pg.Pool;
const ws = WorkspaceId.parse(randomUUID());
const person: Actor = { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId: ws };

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [{ namespace: 'identity-password', dir: fileURLToPath(new URL('../../migrations/', import.meta.url)) }],
  });
  app = createAppPool(db.appUrl, 2);
  sys = createSystemPool(db.systemUrl, 2);
}, 60_000);
afterAll(async () => {
  await app?.end();
  await sys?.end();
  if (db) await dropTestDatabase(db);
});

describe.each(['session_tokens', 'session_cache', 'bootstrap_tokens', 'email_verifications', 'password_credentials'])('app.%s', (table) => {
  it('is not readable or writable by a person transaction', async () => {
    await expect(withActor(person, (tx) => tx.query(`SELECT count(*) FROM app.${table}`), { pool: app })).rejects.toThrow(/permission denied/);
    await expect(withActor(person, (tx) => tx.query(`DELETE FROM app.${table}`), { pool: app })).rejects.toThrow(/permission denied/);
  });

  it('is readable by the system role', async () => {
    const n = await withSystem(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0]?.n, { pool: sys });
    expect(n).toBe(0);
  });
});
