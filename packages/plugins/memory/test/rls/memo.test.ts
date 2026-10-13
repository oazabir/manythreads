import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P5-14, the database half of what retention may do to the feed: the memo of a pruned run is the platform's (no privilege for the request role),
// the two doors (`app.memory_memoize_runs`, `app.memory_retain_log_prune`) are the system role's, and the append-only log is still append-only
// for everyone but that one door.

const { omar, nadia } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let owner: pg.Client;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const asNadia = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(nadia), fn, { pool: appPool });
const asAdmin = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(omar), fn, { pool: appPool });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, approvalsMigrationSource, repoGitMigrationSource, memoryMigrationSource, memoryHindsightMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 2);
  sysPool = createSystemPool(db.systemUrl, 2);
  owner = testClient({ connectionString: db.ownerUrl });
  await owner.connect();
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
});

describe('memory_run_memo', () => {
  it('is system-only: a member and an admin can neither read nor write it', async () => {
    for (const as of [asNadia, asAdmin]) {
      expect(await code(as((tx) => tx.query('SELECT * FROM app.memory_run_memo')))).toBe('42501');
      expect(
        await code(
          as((tx) =>
            tx.query(
              `INSERT INTO app.memory_run_memo (run_id, workspace_id, team_id, bot_id, started_at, ended_at) VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now(), now())`,
              [omar.workspaceId, personas.nadia.workspaceId],
            ),
          ),
        ),
      ).toBe('42501');
    }
  });

  it('keeps the table and its policies within the harness rules', async () => {
    const problems = await explainRlsViolations(owner);
    expect(problems.filter((p) => p.name === 'memory_run_memo')).toEqual([]);
  });

  it('refuses a window that ends before it starts', async () => {
    expect(
      await code(
        sys((tx) =>
          tx.query(
            `INSERT INTO app.memory_run_memo (run_id, workspace_id, team_id, bot_id, started_at, ended_at)
             VALUES (gen_random_uuid(), $1, (SELECT id FROM app.teams LIMIT 1), gen_random_uuid(), now(), now() - interval '1 hour')`,
            [omar.workspaceId],
          ),
        ),
      ),
    ).toBe('23514');
  });
});

describe('the doors', () => {
  it('are executable by the system role only', async () => {
    expect(await code(asAdmin((tx) => tx.query('SELECT app.memory_memoize_runs($1::uuid[])', [[]])))).toBe('42501');
    expect(
      await code(asAdmin((tx) => tx.query('SELECT * FROM app.memory_retain_log_prune($1, now(), NULL, 10, true)', [omar.workspaceId]))),
    ).toBe('42501');
    expect((await sys((tx) => tx.query<{ n: number }>('SELECT app.memory_memoize_runs($1::uuid[]) AS n', [[]]))).rows[0]!.n).toBe(0);
    expect((await sys((tx) => tx.query('SELECT * FROM app.memory_retain_log_prune($1, now(), NULL, 10, true)', [omar.workspaceId]))).rows).toHaveLength(1);
  });

  it('the prune door refuses a page size that is not a page', async () => {
    for (const limit of [0, -1, 10_001]) {
      expect(await code(sys((tx) => tx.query('SELECT * FROM app.memory_retain_log_prune($1, now(), NULL, $2, true)', [omar.workspaceId, limit])))).toBe('22023');
    }
  });

  it('the system role still has no DELETE or UPDATE on the log, and the door never takes a withheld line', async () => {
    expect(await code(sys((tx) => tx.query('DELETE FROM app.memory_retain_log')))).toBe('42501');
    expect(await code(sys((tx) => tx.query("UPDATE app.memory_retain_log SET reason = 'x'")))).toBe('42501');
    const team = (await sys((tx) => tx.query<{ id: string }>('SELECT id FROM app.teams LIMIT 1'))).rows[0]!.id;
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason, created_at)
         VALUES ($1, $2, 'b', 'run', 'door-withheld', 'withheld', 'person_source', now() - interval '3000 days'),
                ($1, $2, 'b', 'run', 'door-note', 'failed', 'x', now() - interval '3000 days')`,
        [omar.workspaceId, team],
      ),
    );
    const res = (await sys((tx) => tx.query<{ pruned: number }>('SELECT * FROM app.memory_retain_log_prune($1, now(), NULL, 100, false)', [omar.workspaceId]))).rows[0]!;
    expect(res.pruned).toBe(1);
    const left = (await sys((tx) => tx.query<{ source_id: string }>("SELECT source_id FROM app.memory_retain_log WHERE source_id LIKE 'door-%'"))).rows.map((r) => r.source_id);
    expect(left).toEqual(['door-withheld']);
  });
});
