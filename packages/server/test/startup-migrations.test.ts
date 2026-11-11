import { createTestDatabase, dropTestDatabase, withClusterLock, type TestDatabase, testClient } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/index.ts';

// PLAN Phase 1 criterion 1 at server level: empty DB -> migrations apply once, a second start applies none,
// and an edited applied file stops the start and names the file.
describe('server start runs migrations (criterion 1)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  }, 60_000);
  afterAll(async () => {
    await dropTestDatabase(db);
  });

  const start = () =>
    startServer({
      port: 0,
      ownerUrl: db.ownerUrl,
      appUrl: db.appUrl,
      systemUrl: db.systemUrl,
      migrationLock: withClusterLock,
      testPlugins: false,
    });
  const owner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = testClient({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const applied = () =>
    owner(async (c) => (await c.query('SELECT id, checksum, applied_at FROM app.schema_migrations ORDER BY id')).rows);

  it('first start applies the files, a second start applies none, an edited file stops the start naming it', async () => {
    const first = await start();
    await first.close();
    const afterFirst = await applied();
    expect(afterFirst.length).toBeGreaterThan(0);

    const second = await start();
    await second.close();
    expect(await applied()).toEqual(afterFirst); // nothing new, nothing re-applied

    const victim = afterFirst[0]!.id as string;
    await owner((c) => c.query("UPDATE app.schema_migrations SET checksum = 'tampered' WHERE id = $1", [victim]));
    await expect(start()).rejects.toThrow(victim);
    expect((await applied()).length).toBe(afterFirst.length);
  }, 120_000);
});

// The 2026-11-09 outage: the new server crashed on its FIRST database connection while Postgres was away. The start now waits, and a
// database that never comes back ends in a clear error (and leaves nothing open).
describe('server start waits for the database', () => {
  it('a database that is not there ends in a clear error after the limit, naming the host and no password', async () => {
    const url = (user: string) => `postgresql://${user}:pw-secret@127.0.0.1:1/manythreads`;
    const started = Date.now();
    const run = startServer({ port: 0, ownerUrl: url('o'), appUrl: url('a'), systemUrl: url('s'), dbConnectTimeoutSeconds: 1, testPlugins: false });
    await expect(run).rejects.toThrow(/127\.0\.0\.1:1 did not take a connection within 1 s/);
    await run.catch((e: Error) => expect(e.message).not.toContain('pw-secret'));
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
