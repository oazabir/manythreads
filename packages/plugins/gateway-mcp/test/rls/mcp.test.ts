import { createAppPool, createSystemPool } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  gatewayMcpMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P5-09: a run's endpoint credential. `mcp_run_tokens` is system-only — no GRANT to manythreads_app — because the
// token *is* the credential: the request role must not be able to enumerate live tokens, mint one or revoke another
// run's. The kernel's run service (ctx.runs) reads and writes the table as the system role; this is the table's own
// half of the gateway's tests, while the mint, the resolve and the close are in gateway.test.ts.

let db: TestDatabase;
let owner: pg.Client;
let appPool: pg.Pool;
let sysPool: pg.Pool;

const code = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(() => undefined, (e: { code?: string }) => e.code);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, gatewayMcpMigrationSource],
  });
  owner = testClient({ connectionString: db.ownerUrl });
  await owner.connect();
  appPool = createAppPool(db.appUrl, 2);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
});

describe('mcp_run_tokens (P5-09)', () => {
  it('passes the RLS harness: forced, with a policy and an rls comment', async () => {
    expect(await explainRlsViolations(owner)).toEqual([]);
    expect(await findPerRowPolicyCalls(owner, 'mcp_run_tokens')).toEqual([]);
  });

  it('is a credential the request role cannot read, mint, revoke or delete (42501, not merely no rows)', async () => {
    for (const sql of [
      'SELECT id FROM app.mcp_run_tokens',
      "INSERT INTO app.mcp_run_tokens (run_id, bot_id, token_hash, expires_at) VALUES (gen_random_uuid(), gen_random_uuid(), '\\x00'::bytea, now() + interval '1 minute')",
      'UPDATE app.mcp_run_tokens SET revoked_at = now()',
      'DELETE FROM app.mcp_run_tokens',
    ]) {
      expect(await code(appPool.query(sql)), sql).toBe('42501');
    }
  });

  it('the system role may read and write it, and the expiry CHECK refuses a token that is born dead', async () => {
    expect((await sysPool.query<{ n: number }>('SELECT count(*)::int AS n FROM app.mcp_run_tokens')).rows[0]?.n).toBe(0);
    expect(
      await code(
        sysPool.query(
          `INSERT INTO app.mcp_run_tokens (run_id, bot_id, token_hash, expires_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), '\\x00'::bytea, now() - interval '1 minute')`,
        ),
      ),
    ).toBe('23514');
  });
});
