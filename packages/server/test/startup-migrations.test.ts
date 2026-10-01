import { createTestDatabase, dropTestDatabase, withClusterLock, type TestDatabase } from '@manythreads/test-utils';
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
    const c = new pg.Client({ connectionString: db.ownerUrl });
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
