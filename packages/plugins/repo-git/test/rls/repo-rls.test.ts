import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  repoGitMigrationSource,
  searchMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  TEAM_IDS,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, sameera, priya, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const SUP = TEAM_IDS['Customer support'];
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const sha = (n: number): string => n.toString(16).padStart(40, '0');

const apply = (team: string, expected: string | null, head: string, paths: string[], opts: { replace?: boolean } = {}) =>
  sys((tx) =>
    tx.query('SELECT app.repo_index_apply($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7, false)', [
      team,
      expected,
      head,
      JSON.stringify([{ sha: head, parent_sha: expected, author_id: null, co_authors: [], message: `commit ${head.slice(-4)}`, committed_at: new Date().toISOString(), paths }]),
      JSON.stringify(paths.map((p) => ({ path: p, blob_sha: sha(99), size: 3, last_commit_sha: head, text_plain: `text of ${p}` }))),
      [],
      opts.replace === true,
    ]),
  );
const seen = async (p: Persona, table: string): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ team_id: string }>(`SELECT DISTINCT team_id FROM app.${table} ORDER BY team_id`)).rows.map((r) => r.team_id));
const names = (ids: string[]): string[] => ids.map((id) => (id === ENG ? 'eng' : id === SUP ? 'sup' : id === MKT ? 'mkt' : id));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, searchMigrationSource, repoGitMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  for (const team of [ENG, SUP, MKT]) {
    await sys((tx) => tx.query('SELECT app.repo_register($1, $2)', [team, `${team}.git`]));
    await apply(team, null, sha(1), ['TEAM.md', 'pages/a.md']);
  }
  await apply(ENG, sha(1), sha(2), ['pages/runbook.md', 'pages/deploy.md']);
  // enough rows that the planner prefers the trigram indexes to a scan of the primary key (a small table never does)
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  await owner.query(
    `INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain)
     SELECT $1, 'pages/bulk/' || (i % 50) || '/' || md5(i::text) || '.md', repeat('a', 40), 1, repeat('b', 40), md5((i * 3)::text) || ' ' || md5((i * 5)::text)
     FROM generate_series(1, 100000) i`,
    [SUP],
  );
  await owner.query('ANALYZE app.repo_entries');
  await owner.end();
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the repo tables pass the RLS harness', () => {
  it('RLS enabled and forced, policies, an rls comment, and no per-row helper call in the read plan', async () => {
    const admin = new pg.Client({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['repos', 'repo_entries', 'repo_commits']) {
        expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
        const c = await admin.query<{ comment: string }>(`SELECT obj_description(('app.' || $1)::regclass, 'pg_class') AS comment`, [table]);
        expect(c.rows[0]?.comment, table).toMatch(/^rls: team/);
      }
    } finally {
      await admin.end();
    }
  });

  it('the policy hoists the readable team set', async () => {
    const plan = await as(nadia, async (tx) => (await tx.query<{ 'QUERY PLAN': string }>('EXPLAIN (VERBOSE, COSTS OFF) SELECT count(*) FROM app.repo_entries')).rows.map((r) => r['QUERY PLAN']).join('\n'));
    expect(plan).toContain('readable_team_ids');
    expect(plan).not.toMatch(/can_in_team|app\.can\(|is_team_member/);
  });

  it('the trigram indexes on path and page text serve a member’s query under the policy', async () => {
    for (const [column, query] of [['path', 'runbook'], ['text_plain', 'text of pages/runbook']] as const) {
      const plan = await as(nadia, async (tx) => {
        return (await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) SELECT path FROM app.repo_entries WHERE ${column} %> $1`, [query])).rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan, column).toContain(column === 'path' ? 'repo_entries_path_trgm' : 'repo_entries_text_trgm');
    }
    const hits = await as(nadia, async (tx) => (await tx.query<{ path: string }>('SELECT path FROM app.repo_entries WHERE path %> $1 ORDER BY path', ['runbook'])).rows.map((r) => r.path));
    expect(hits).toEqual(['pages/runbook.md']);
  });
});

describe('who sees what: whoever reads the team', () => {
  it.each(['repos', 'repo_entries', 'repo_commits'])('%s: a member sees their teams, an admin all, a guest nothing', async (table) => {
    expect(names(await seen(nadia, table))).toEqual(['eng']); // Engineering only
    expect(names(await seen(sameera, table))).toEqual(['sup']);
    expect(names(await seen(priya, table)).sort()).toEqual(['eng', 'mkt']); // two teams
    expect(names(await seen(omar, table)).sort()).toEqual(['eng', 'mkt', 'sup']); // workspace admin
    expect(await seen(lena, table)).toEqual([]); // guest
  });

  it('a member sees the files of their team and none of another', async () => {
    const files = await as(nadia, async (tx) => (await tx.query<{ path: string }>('SELECT path FROM app.repo_entries ORDER BY path')).rows.map((r) => r.path));
    expect([...files].sort()).toEqual(['TEAM.md', 'pages/a.md', 'pages/deploy.md', 'pages/runbook.md']);
    const sup = await as(sameera, async (tx) => (await tx.query<{ path: string }>("SELECT path FROM app.repo_entries WHERE path NOT LIKE 'pages/bulk/%'")).rows.map((r) => r.path));
    expect([...sup].sort()).toEqual(['TEAM.md', 'pages/a.md']);
  });
});

describe('who writes: nobody directly, members through the definer functions', () => {
  it.each(['repos', 'repo_entries', 'repo_commits'])('%s: the app role has no write privilege, whoever the person is', async (table) => {
    for (const p of [nadia, omar]) {
      expect(await code(as(p, (tx) => tx.query(`DELETE FROM app.${table}`)))).toBe('42501');
      expect(await code(as(p, (tx) => tx.query(`UPDATE app.${table} SET team_id = team_id`)))).toBe('42501');
    }
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.repo_commits (team_id, sha, message, committed_at) VALUES ($1, $2, 'x', now())`, [ENG, sha(7)])))).toBe('42501');
  });

  it('repo_register and repo_index_apply: a member who may post passes, an outsider and a guest get 42501', async () => {
    const call = (p: Persona, team: string) => as(p, (tx) => tx.query('SELECT app.repo_register($1, $2)', [team, `${team}.git`]));
    expect(await code(call(nadia, ENG))).toBeUndefined();
    expect(await code(call(sameera, ENG))).toBe('42501');
    expect(await code(call(lena, ENG))).toBe('42501');
    expect(await code(call(nadia, MKT))).toBe('42501');
    expect(await code(call(omar, ENG))).toBeUndefined(); // an admin may post everywhere
    const index = (p: Persona, team: string) =>
      as(p, (tx) => tx.query(`SELECT app.repo_index_apply($1, $2, $3, '[]'::jsonb, '[]'::jsonb, '{}'::text[], false, false)`, [team, sha(2), sha(2)]));
    expect(await code(index(nadia, ENG))).toBeUndefined();
    expect(await code(index(sameera, ENG))).toBe('42501');
    expect(await code(index(lena, ENG))).toBe('42501');
    expect(await code(as(sameera, (tx) => tx.query('SELECT app.repo_seed($1)', [ENG])))).toBe('42501');
    expect(await code(as(lena, (tx) => tx.query('SELECT app.repo_seed($1)', [ENG])))).toBe('42501');
  });

  it('an index update built on a head that is no longer the head is refused (55000) and changes nothing', async () => {
    const before = await sys(async (tx) => (await tx.query<{ head_sha: string }>('SELECT head_sha FROM app.repos WHERE team_id = $1', [SUP])).rows[0]!.head_sha);
    expect(await code(apply(SUP, sha(77), sha(78), ['pages/lost.md']))).toBe('55000');
    const after = await sys(async (tx) => (await tx.query<{ head_sha: string }>('SELECT head_sha FROM app.repos WHERE team_id = $1', [SUP])).rows[0]!.head_sha);
    expect(after).toBe(before);
    expect(await sys(async (tx) => (await tx.query("SELECT 1 FROM app.repo_entries WHERE path = 'pages/lost.md'")).rows.length)).toBe(0);
  });

  it('replace-all rebuilds the file index; deletes remove files; a commit row is kept once however often it is applied', async () => {
    await apply(MKT, sha(1), sha(3), ['pages/only.md'], { replace: true });
    expect(await sys(async (tx) => (await tx.query<{ path: string }>('SELECT path FROM app.repo_entries WHERE team_id = $1 ORDER BY path', [MKT])).rows.map((r) => r.path))).toEqual(['pages/only.md']);
    await sys((tx) =>
      tx.query(`SELECT app.repo_index_apply($1, $2, $3, '[]'::jsonb, '[]'::jsonb, ARRAY['pages/only.md'], false, false)`, [MKT, sha(3), sha(3)]),
    );
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.repo_entries WHERE team_id = $1', [MKT])).rows.length)).toBe(0);
    await apply(MKT, sha(3), sha(4), ['pages/x.md']);
    await sys((tx) =>
      tx.query(`SELECT app.repo_index_apply($1, $2, $3, $4::jsonb, '[]'::jsonb, '{}'::text[], true, false)`, [
        MKT,
        sha(4),
        sha(4),
        JSON.stringify([{ sha: sha(4), parent_sha: sha(3), author_id: null, co_authors: [], message: 'again', committed_at: new Date().toISOString(), paths: [] }]),
      ]),
    );
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.repo_commits WHERE team_id = $1 AND sha = $2', [MKT, sha(4)])).rows.length)).toBe(1);
  });

  it('deleting a team deletes its repo rows', async () => {
    const id = await sys(async (tx) => {
      const r = await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'doomed', 'Doomed') RETURNING id`, [omar.workspaceId]);
      return r.rows[0]!.id;
    });
    await sys((tx) => tx.query('SELECT app.repo_register($1, $2)', [id, `${id}.git`]));
    await apply(id, null, sha(5), ['a.md']);
    await sys((tx) => tx.query('DELETE FROM app.teams WHERE id = $1', [id]));
    for (const table of ['repos', 'repo_entries', 'repo_commits']) {
      expect(await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.${table} WHERE team_id = $1`, [id])).rows.length), table).toBe(0);
    }
  });
});
