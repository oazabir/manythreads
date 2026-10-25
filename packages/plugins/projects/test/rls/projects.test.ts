import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  personaActor,
  personas,
  projectsMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import { createAppPool, withActor, type Tx } from '@manythreads/kernel';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, sameera, lena } = personas;
const ENGINEERING = '00000000-0000-7000-8000-0000000b0001';
const SUPPORT = '00000000-0000-7000-8000-0000000b0002';

let db: TestDatabase;
let appPool: pg.Pool;
const as = <T>(p: typeof omar, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const insert = (tx: Tx, team: string, name: string) =>
  tx.query(`INSERT INTO app.projects (workspace_id, team_id, name, repo_url) VALUES (app.workspace_id(), $1, $2, 'https://github.com/a/b')`, [team, name]);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, projectsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  await as(omar, (tx) => insert(tx, ENGINEERING, 'manythreads'));
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('projects: row-level security', () => {
  it('passes the RLS harness (enabled, forced, policy, comment)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('team members read their own team projects and nobody else does', async () => {
    const count = (p: typeof omar) => as(p, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.projects')).rows[0]?.n);
    expect(await count(nadia)).toBe(1);
    expect(await count(omar)).toBe(1);
    expect(await count(sameera)).toBe(0);
    expect(await count(lena)).toBe(0);
  });

  it('only a lead or workspace admin writes; a plain member and an outsider are refused', async () => {
    await expect(as(nadia, (tx) => insert(tx, ENGINEERING, 'nope'))).rejects.toMatchObject({ code: '42501' });
    await expect(as(sameera, (tx) => insert(tx, ENGINEERING, 'nope'))).rejects.toMatchObject({ code: '42501' });
    await expect(as(omar, (tx) => insert(tx, SUPPORT, 'ok-admin'))).resolves.toBeDefined();
    expect((await as(nadia, (tx) => tx.query("UPDATE app.projects SET default_branch = 'x' WHERE team_id = $1", [ENGINEERING]))).rowCount).toBe(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.projects WHERE team_id = $1', [ENGINEERING]))).rowCount).toBe(0);
  });

  it('refuses an address that is not plain https', async () => {
    for (const bad of ['http://a.example/x', 'https://u:p@a.example/x', 'https://a.example/x?y=1'])
      await expect(as(omar, (tx) => tx.query(`INSERT INTO app.projects (workspace_id, team_id, name, repo_url) VALUES (app.workspace_id(), $1, 'bad', $2)`, [ENGINEERING, bad]))).rejects.toMatchObject({ code: '23514' });
  });
});
