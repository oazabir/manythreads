import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botRunnersMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  runtimeHermesMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, tariq } = personas;

// Who reads and writes what (pnpm test:rls). Runners are for workspace admins; a team member reads only the short view through app.bot_runners_for_team,
// and only for a team they belong to. A team lead can no longer write a Hermes connection.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let sharedId = '';
let engineeringOnlyId = '';
let offId = '';
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const insertRunner = (p: Persona, name: string, kind = 'hermes_pod', extra = ''): Promise<{ rows: { id: string }[] }> =>
  as(p, (tx) =>
    tx.query<{ id: string }>(`INSERT INTO app.bot_runners (workspace_id, name, label, kind${extra === '' ? '' : ', all_teams'}) VALUES ($1, $2, $3, $4${extra === '' ? '' : `, ${extra}`}) RETURNING id`, [
      omar.workspaceId,
      name,
      `Runner ${name}`,
      kind,
    ]),
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, runtimeHermesMigrationSource, botRunnersMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  // one runner for every team, one for Engineering only, one switched off for Engineering
  sharedId = (await insertRunner(omar, 'shared-pod', 'hermes_pod', 'true')).rows[0]!.id;
  engineeringOnlyId = (await insertRunner(omar, 'eng-only')).rows[0]!.id;
  offId = (await insertRunner(omar, 'eng-off')).rows[0]!.id;
  await as(omar, async (tx) => {
    await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1, $2), ($3, $2)', [engineeringOnlyId, TEAM_IDS.Engineering, offId]);
    await tx.query("UPDATE app.bot_runners SET enabled = false, plan_label = 'Max' WHERE id = $1", [offId]);
  });
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the runner tables pass the RLS harness', () => {
  it('RLS is enabled and forced on both tables, with policies and an rls comment; no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['bot_runners', 'bot_runner_teams', 'bot_runner_usage']) {
        expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
        const plan = await admin.query('SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass', [`app.${table}`]);
        expect(plan.rows[0], table).toEqual({ on: true, forced: true });
      }
    } finally {
      await admin.end();
    }
  });
});

describe('the tables are for workspace admins only', () => {
  it('an admin reads every runner and every list; a member and a team lead read none', async () => {
    expect((await q(omar, 'SELECT id FROM app.bot_runners')).map((r) => r['id']).sort()).toEqual([sharedId, engineeringOnlyId, offId].sort());
    expect(await q(omar, 'SELECT runner_id FROM app.bot_runner_teams')).toHaveLength(2);
    for (const who of [nadia, tariq]) {
      expect(await q(who, 'SELECT id FROM app.bot_runners')).toEqual([]);
      expect(await q(who, 'SELECT runner_id FROM app.bot_runner_teams')).toEqual([]);
    }
  });

  it('a member and a team lead cannot make, change, share or remove a runner', async () => {
    for (const who of [nadia, tariq]) {
      expect(await code(insertRunner(who, `by-${who.name.toLowerCase()}`))).toBe('42501');
      expect((await as(who, (tx) => tx.query('UPDATE app.bot_runners SET label = $2 WHERE id = $1 RETURNING id', [sharedId, 'hijacked']))).rows).toHaveLength(0);
      expect((await as(who, (tx) => tx.query('DELETE FROM app.bot_runners WHERE id = $1 RETURNING id', [sharedId]))).rows).toHaveLength(0);
      expect(await code(as(who, (tx) => tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1, $2)', [sharedId, TEAM_IDS.Marketing])))).toBe('42501');
    }
    expect((await q(omar, 'SELECT label FROM app.bot_runners WHERE id = $1', [sharedId]))[0]).toEqual({ label: 'Runner shared-pod' });
  });

  it('only one default per workspace, only the five kinds, and a name once per workspace', async () => {
    await as(omar, (tx) => tx.query('UPDATE app.bot_runners SET is_default = true WHERE id = $1', [sharedId]));
    expect(await code(as(omar, (tx) => tx.query('UPDATE app.bot_runners SET is_default = true WHERE id = $1', [engineeringOnlyId])))).toBe('23505');
    expect(await code(insertRunner(omar, 'bad-kind', 'made_up'))).toBe('23514');
    expect(await code(insertRunner(omar, 'shared-pod'))).toBe('23505');
    for (const kind of ['hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway']) {
      const made = await insertRunner(omar, `kind-${kind.replace('_', '-')}`, kind);
      await as(omar, (tx) => tx.query('DELETE FROM app.bot_runners WHERE id = $1', [made.rows[0]!.id]));
    }
    await as(omar, (tx) => tx.query('UPDATE app.bot_runners SET is_default = false WHERE id = $1', [sharedId]));
  });
});

describe('what a team sees: app.bot_runners_for_team', () => {
  const forTeam = (p: Persona, teamId: string) => q(p, 'SELECT * FROM app.bot_runners_for_team($1)', [teamId]);

  it('a member of the team gets the runners available to it with exactly eight fields, and nothing else', async () => {
    const rows = await forTeam(nadia, TEAM_IDS.Engineering);
    expect(rows.map((r) => r['name']).sort()).toEqual(['eng-off', 'eng-only', 'shared-pod']);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['is_default', 'kind', 'label', 'name', 'owner_name', 'plan_label', 'shared_with', 'status']);
    const off = rows.find((r) => r['name'] === 'eng-off')!;
    expect(off).toMatchObject({ status: 'off', plan_label: 'Max' });
    // how many teams share it: a runner for every team counts the workspace's teams, one with a list counts the list
    const teamCount = await sys(async (tx) => Number((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.teams')).rows[0]!.n));
    expect(rows.find((r) => r['name'] === 'shared-pod')).toMatchObject({ shared_with: teamCount });
    expect(rows.find((r) => r['name'] === 'eng-only')).toMatchObject({ shared_with: 1 });
    // no address, key, node or expiry by any column name
    expect(JSON.stringify(rows)).not.toMatch(/base_url|secret|node|expires/);
  });

  it('a team that is not on a runner\'s list does not get it', async () => {
    expect((await forTeam(tariq, TEAM_IDS.Marketing)).map((r) => r['name'])).toEqual(['shared-pod']);
  });

  it('someone who is not in the team is refused, and so is a team that does not exist', async () => {
    expect(await code(forTeam(tariq, TEAM_IDS.Engineering))).toBe('42501');
    expect(await code(forTeam(nadia, TEAM_IDS.Marketing))).toBe('42501');
    expect(await code(forTeam(nadia, '00000000-0000-7000-8000-00000000dead'))).toBe('42501');
  });

  it('a workspace admin may ask for any team of the workspace', async () => {
    expect((await forTeam(omar, TEAM_IDS.Marketing)).map((r) => r['name'])).toEqual(['shared-pod']);
  });

  it('the function is not callable by anyone outside the app role', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const res = await admin.query("SELECT has_function_privilege('public', 'app.bot_runners_for_team(uuid)', 'EXECUTE') AS pub, prosecdef AS definer, proconfig FROM pg_proc WHERE oid = 'app.bot_runners_for_team(uuid)'::regprocedure");
      expect(res.rows[0]).toMatchObject({ pub: false, definer: true });
      expect(JSON.stringify(res.rows[0]?.['proconfig'])).toContain('search_path');
    } finally {
      await admin.end();
    }
  });
});

describe('a team lead can no longer write a Hermes connection', () => {
  it('the platform and a workspace admin write connections; a lead of the team does not', async () => {
    const insert = (p: Persona) =>
      as(p, (tx) =>
        tx.query("INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, base_url) VALUES ($1, $2, $3, 'external', 'http://example.test:8642') RETURNING id", [
          omar.workspaceId,
          TEAM_IDS.Marketing,
          `by-${p.name.toLowerCase()}`,
        ]),
      );
    expect(await code(insert(tariq))).toBe('42501');
    expect(await code(insert(nadia))).toBe('42501');
    const made = (await insert(omar)).rows[0] as { id: string };
    expect(made.id).toBeTruthy();
    // a lead reads the team's connections but cannot change or remove one
    expect((await q(tariq, 'SELECT id FROM app.hermes_connections WHERE id = $1', [made.id])).length).toBe(1);
    expect((await as(tariq, (tx) => tx.query("UPDATE app.hermes_connections SET base_url = 'http://other.test' WHERE id = $1 RETURNING id", [made.id]))).rows).toHaveLength(0);
    expect((await as(tariq, (tx) => tx.query('DELETE FROM app.hermes_connections WHERE id = $1 RETURNING id', [made.id]))).rows).toHaveLength(0);
    expect((await sys((tx) => tx.query('UPDATE app.hermes_connections SET status = $2 WHERE id = $1 RETURNING id', [made.id, 'ok']))).rows).toHaveLength(1);
  });
});

describe('the usage table (P19-07)', () => {
  it('is read by a workspace admin, invisible to a team lead and a member, and written by the system only', async () => {
    await sys((tx) =>
      tx.query(`INSERT INTO app.bot_runner_usage (workspace_id, runner_id, team_id, day, runs, seconds, cli_cost) VALUES ($1, $2, $3, current_date, 2, 40, 0.5)`, [omar.workspaceId, sharedId, TEAM_IDS.Engineering]),
    );
    expect(await q(omar, 'SELECT runs FROM app.bot_runner_usage')).toHaveLength(1);
    expect(await q(tariq, 'SELECT runs FROM app.bot_runner_usage')).toHaveLength(0);
    expect(await q(nadia, 'SELECT runs FROM app.bot_runner_usage')).toHaveLength(0);
    // not even an admin writes it: the numbers come from runs
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.bot_runner_usage SET runs = 99`)))).toBeUndefined();
    expect((await sys((tx) => tx.query('SELECT runs FROM app.bot_runner_usage'))).rows[0]).toMatchObject({ runs: 2 });
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.bot_runner_usage (workspace_id, runner_id, team_id, day) VALUES ($1, $2, $3, current_date - 1)`, [omar.workspaceId, sharedId, TEAM_IDS.Engineering])))).toBe('42501');
    expect(await code(as(tariq, (tx) => tx.query(`INSERT INTO app.bot_runner_usage (workspace_id, runner_id, team_id, day) VALUES ($1, $2, $3, current_date - 1)`, [omar.workspaceId, sharedId, TEAM_IDS.Engineering])))).toBe('42501');
  });
});
