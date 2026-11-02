import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  workshopMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// P7-09: the record of a terminal an admin opened into a bot's sandbox. Workspace admins (and nobody else) read every record of their workspace and may ask for a terminal in their own name; the
// server alone (the system role) writes the bookkeeping. The database also ties a terminal to a rehearsal run of its own bot, and keeps the record when a bot or team is deleted.

const { omar, nadia, priya } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let botId = '';
let rehearsalRun = '';
let realRun = '';
let outsider: { ws: string; actor: string };
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

/** A terminal asked for by `p` in their own name (what the route does as the caller). */
const ask = (p: Persona, runId: string | null = null): Promise<string> =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, run_id) VALUES ($1, $2, $3, 'helper', (SELECT app.actor()), $4) RETURNING id`,
        [p.workspaceId, ENG, botId, runId],
      )
    ).rows[0]!.id,
  );
const endIt = (id: string): Promise<unknown> =>
  sys((tx) => tx.query("UPDATE app.terminal_sessions SET status = 'ended', end_reason = 'closed', ended_at = now() WHERE id = $1", [id]));
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.terminal_sessions ORDER BY id')).rows.map((r) => r.id));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, workshopMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'helper', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [omar.workspaceId, ENG],
      )
    ).rows[0]!.id;
    const run = (rehearsal: boolean, trigger: string): Promise<string> =>
      tx
        .query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, rehearsal) VALUES ($1, $2, $3, $4, 'stopped', $5) RETURNING id`, [omar.workspaceId, botId, ENG, trigger, rehearsal])
        .then((r) => r.rows[0]!.id);
    rehearsalRun = await run(true, 'conversation');
    realRun = await run(false, 'mention');
    const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other-term', 'Other') RETURNING id`)).rows[0]!.id;
    const person = (await tx.query<{ id: string }>(`INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`, [ws])).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])).rows[0]!.id;
    await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
    outsider = { ws, actor };
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

// a failed test must not leave a live terminal that blocks the next one
afterEach(async () => {
  await sys((tx) => tx.query("UPDATE app.terminal_sessions SET status = 'ended', end_reason = 'closed', ended_at = now() WHERE status IN ('waiting', 'open')"));
});

describe('terminal sessions (P7-09)', () => {
  it('pass the RLS harness and read without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'terminal_sessions')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('are read by the admins of the workspace and by nobody else: not a lead, not a member, not another workspace', async () => {
    const mine = await ask(omar, rehearsalRun);
    await endIt(mine);
    expect(await visible(omar)).toContain(mine);
    // priya leads a team and nadia is a member: neither is a workspace admin
    expect(await visible(priya)).toEqual([]);
    expect(await visible(nadia)).toEqual([]);
    const stranger = await withActor({ kind: 'person', id: outsider.actor as never, workspaceId: outsider.ws as never }, async (tx) => (await tx.query('SELECT 1 FROM app.terminal_sessions')).rows.length, { pool: appPool });
    expect(stranger).toBe(0);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.terminal_sessions WHERE id = $1', [mine])).rows.length)).toBe(1);
  });

  it('can be asked for only by an admin, only in their own name, only in their own workspace, and only as `waiting`', async () => {
    for (const p of [nadia, priya]) expect(await code(ask(p)), p.name).toBe('42501');
    const inSomeoneElsesName = as(omar, (tx) =>
      tx.query(`INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id) VALUES ($1, $2, $3, 'helper', $4)`, [omar.workspaceId, ENG, botId, nadia.actorId]),
    );
    expect(await code(inSomeoneElsesName)).toBe('42501');
    const inAnotherWorkspace = withActor({ kind: 'person', id: outsider.actor as never, workspaceId: outsider.ws as never }, (tx) =>
      tx.query(`INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id) VALUES ($1, $2, $3, 'helper', (SELECT app.actor()))`, [omar.workspaceId, ENG, botId]),
    { pool: appPool });
    expect(await code(inAnotherWorkspace)).toBe('42501');
    const alreadyOpen = as(omar, (tx) =>
      tx.query(`INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, status) VALUES ($1, $2, $3, 'helper', (SELECT app.actor()), 'open')`, [omar.workspaceId, ENG, botId]),
    );
    expect(await code(alreadyOpen)).toBe('42501');
    // and under the team the bot really belongs to: the database refuses a bot filed under another team's name
    const wrongTeam = as(omar, (tx) =>
      tx.query(`INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id) VALUES ($1, $2, $3, 'helper', (SELECT app.actor()))`, [omar.workspaceId, TEAM_IDS.Marketing, botId]),
    );
    expect(await code(wrongTeam)).toBe('23514');
  });

  it('are changed and deleted by the server alone: the person at the keyboard cannot rewrite their own record', async () => {
    const id = await ask(omar);
    expect(await as(omar, async (tx) => (await tx.query("UPDATE app.terminal_sessions SET status = 'open', bytes_out = 0 WHERE id = $1", [id])).rowCount)).toBe(0);
    expect(await as(omar, async (tx) => (await tx.query("UPDATE app.terminal_sessions SET transcript = 'nothing happened' WHERE id = $1", [id])).rowCount)).toBe(0);
    // the app role has no DELETE privilege at all
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.terminal_sessions WHERE id = $1', [id])))).toBe('42501');
    expect(await sys(async (tx) => (await tx.query("UPDATE app.terminal_sessions SET status = 'open', started_at = now() WHERE id = $1", [id])).rowCount)).toBe(1);
    await endIt(id);
  });

  it('allow one live terminal per admin, and a second after the first has ended', async () => {
    const first = await ask(omar);
    expect(await code(ask(omar))).toBe('23505');
    // another admin is not blocked by it
    await sys((tx) => tx.query("UPDATE app.workspace_members SET role = 'admin' WHERE person_id = $1", [priya.personId]));
    try {
      const other = await ask(priya);
      await endIt(other);
    } finally {
      await sys((tx) => tx.query("UPDATE app.workspace_members SET role = 'member' WHERE person_id = $1", [priya.personId]));
    }
    await endIt(first);
    await endIt(await ask(omar));
  });

  it('refuse a state the shape does not allow', async () => {
    const id = await ask(omar);
    expect(await code(sys((tx) => tx.query("UPDATE app.terminal_sessions SET status = 'ended' WHERE id = $1", [id])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.terminal_sessions SET status = 'sideways' WHERE id = $1", [id])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.terminal_sessions SET end_reason = 'whenever', status = 'ended', ended_at = now() WHERE id = $1", [id])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.terminal_sessions SET bytes_in = -1 WHERE id = $1", [id])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.terminal_sessions SET transcript = repeat('x', 300000) WHERE id = $1", [id])))).toBe('23514');
    await endIt(id);
  });

  it('are tied by the database to a rehearsal run of the same bot, whoever writes the row', async () => {
    // a real run, a run that does not exist, and a rehearsal of ANOTHER bot are all refused, even for the system role
    const other = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'sibling', 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
            [omar.workspaceId, ENG],
          )
        ).rows[0]!.id,
    );
    const otherRun = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, rehearsal) VALUES ($1, $2, $3, 'conversation', 'stopped', true) RETURNING id`, [omar.workspaceId, other, ENG])
        ).rows[0]!.id,
    );
    expect(await code(ask(omar, realRun))).toBe('23514');
    expect(await code(ask(omar, otherRun))).toBe('23514');
    expect(await code(ask(omar, '00000000-0000-7000-8000-00000000ffff'))).toBeDefined();
    // the tie cannot be moved to a real run afterwards either
    const id = await ask(omar, rehearsalRun);
    expect(await code(sys((tx) => tx.query('UPDATE app.terminal_sessions SET run_id = $2 WHERE id = $1', [id, realRun])))).toBe('23514');
    await endIt(id);
  });

  it('survive the deletion of the bot and of the team: the record stays, the bot\'s name stays on it', async () => {
    const slug = 'short-lived';
    const { team, bot } = await sys(async (tx) => {
      const t = (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, $2, 'Short lived') RETURNING id`, [omar.workspaceId, slug])).rows[0]!.id;
      const b = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('f', 64), 'active') RETURNING id`,
          [omar.workspaceId, t, slug],
        )
      ).rows[0]!.id;
      return { team: t, bot: b };
    });
    const id = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.terminal_sessions (workspace_id, team_id, bot_id, bot_slug, admin_id, status, end_reason, ended_at, transcript) VALUES ($1, $2, $3, $4, $5, 'ended', 'closed', now(), 'kept') RETURNING id`,
            [omar.workspaceId, team, bot, slug, omar.actorId],
          )
        ).rows[0]!.id,
    );
    await sys(async (tx) => {
      await tx.query('DELETE FROM app.bots WHERE id = $1', [bot]);
      await tx.query('DELETE FROM app.teams WHERE id = $1', [team]);
    });
    const kept = await as(omar, async (tx) => (await tx.query<{ bot_id: string | null; team_id: string | null; bot_slug: string; transcript: string }>('SELECT bot_id, team_id, bot_slug, transcript FROM app.terminal_sessions WHERE id = $1', [id])).rows);
    expect(kept).toEqual([{ bot_id: null, team_id: null, bot_slug: slug, transcript: 'kept' }]);
  });
});
