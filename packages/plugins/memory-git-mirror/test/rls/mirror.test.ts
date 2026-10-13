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
  memoryGitMirrorMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  TEAM_IDS,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The mirror's two tables are the platform's: no privilege for the request role (not even an admin's), every policy system-only, and a team that
// is deleted takes its rows with it.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let owner: pg.Client;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      botsMigrationSource,
      approvalsMigrationSource,
      repoGitMigrationSource,
      memoryMigrationSource,
      memoryHindsightMigrationSource,
      memoryGitMirrorMigrationSource,
    ],
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

describe.each(['memory_mirror_pending', 'memory_mirror_teams'])('%s', (table) => {
  it('is invisible and unwritable to the request role, an admin included', async () => {
    for (const who of [nadia, omar]) {
      expect(await code(withActor(personaActor(who), (tx) => tx.query(`SELECT * FROM app.${table}`), { pool: appPool }))).toBe('42501');
      expect(await code(withActor(personaActor(who), (tx) => tx.query(`DELETE FROM app.${table}`), { pool: appPool }))).toBe('42501');
    }
  });

  it('is within the harness rules (forced RLS, a policy, a comment)', async () => {
    expect((await explainRlsViolations(owner)).filter((p) => p.name === table)).toEqual([]);
  });
});

describe('the work list', () => {
  it('takes a row for a team and a path once, and a team that goes takes its rows', async () => {
    const team = (await sys((tx) => tx.query<{ id: string }>("INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'doomed', 'Doomed') RETURNING id", [omar.workspaceId]))).rows[0]!.id;
    await sys(async (tx) => {
      await tx.query('INSERT INTO app.memory_mirror_pending (team_id, path, workspace_id) VALUES ($1, $2, $3)', [team, 'memory/facts/a.md', omar.workspaceId]);
      await tx.query('INSERT INTO app.memory_mirror_teams (team_id, workspace_id) VALUES ($1, $2)', [team, omar.workspaceId]);
    });
    expect(
      await code(sys((tx) => tx.query('INSERT INTO app.memory_mirror_pending (team_id, path, workspace_id) VALUES ($1, $2, $3)', [team, 'memory/facts/a.md', omar.workspaceId]))),
    ).toBe('23505');
    await sys((tx) => tx.query('DELETE FROM app.teams WHERE id = $1', [team]));
    const left = await sys(async (tx) => (await tx.query('SELECT 1 FROM app.memory_mirror_pending WHERE team_id = $1', [team])).rows.length);
    expect(left).toBe(0);
    // a row for another team is not this one's
    await sys((tx) => tx.query('INSERT INTO app.memory_mirror_pending (team_id, path, workspace_id) VALUES ($1, $2, $3)', [ENG, 'memory/facts/b.md', omar.workspaceId]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.memory_mirror_pending WHERE team_id = $1', [ENG])).rows.length)).toBe(1);
  });
});
