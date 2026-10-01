import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbKv, createSystemPool } from '../../src/index.ts';

const ws = '00000000-0000-7000-8000-00000000a001';
const team = '00000000-0000-7000-8000-0000000b0001';

describe('DB-backed ScopedKv', () => {
  let db: TestDatabase;
  let pool: ReturnType<typeof createSystemPool>;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createSystemPool(db.systemUrl, 3);
  });
  afterAll(async () => {
    await pool.end();
    await dropTestDatabase(db);
  });

  it('round-trips JSON, upserts, deletes and reports absence', async () => {
    const kv = createDbKv({ plugin: 'a', pool });
    const scope = { type: 'team', id: team } as const;
    expect(await kv.get(scope, 'k')).toBeUndefined();
    await kv.set(scope, 'k', { n: 1, list: [1, 2] });
    expect(await kv.get(scope, 'k')).toEqual({ n: 1, list: [1, 2] });
    await kv.set(scope, 'k', 'replaced');
    expect(await kv.get(scope, 'k')).toBe('replaced');
    expect(await kv.delete(scope, 'k')).toBe(true);
    expect(await kv.delete(scope, 'k')).toBe(false);
    await expect(kv.set(scope, 'k', undefined)).rejects.toThrow();
  });

  it('namespaces by plugin and by scope', async () => {
    const a = createDbKv({ plugin: 'a', pool });
    const b = createDbKv({ plugin: 'b', pool });
    await a.set({ type: 'workspace', id: ws }, 'k', 1);
    expect(await b.get({ type: 'workspace', id: ws }, 'k')).toBeUndefined();
    expect(await a.get({ type: 'team', id: team }, 'k')).toBeUndefined();
    expect(await a.get({ type: 'workspace', id: ws }, 'k')).toBe(1);
  });
});
