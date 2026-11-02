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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P7-05: a Workshop conversation holds what a person said and what a rehearsal of the bot would have answered. Only the person who started it reads or writes it: not a lead, not an admin;
// the system (the job) does.

const { omar, nadia, priya } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let botId = '';
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const start = (p: Persona, mode = 'rehearse'): Promise<string> =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.workshop_sessions (workspace_id, team_id, bot_id, bot_slug, owner_id, mode) VALUES ($1, $2, $3, 'helper', (SELECT app.actor()), $4) RETURNING id`,
        [p.workspaceId, ENG, botId, mode],
      )
    ).rows[0]!.id,
  );
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workshop_sessions ORDER BY id')).rows.map((r) => r.id));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, workshopMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  botId = await sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'helper', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id,
  );
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('workshop sessions (P7-05)', () => {
  it('pass the RLS harness and read without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'workshop_sessions')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('are read by their owner alone: a team member, the team lead and the workspace admin see nothing of them', async () => {
    const mine = await start(nadia);
    expect(await visible(nadia)).toContain(mine);
    expect(await visible(priya)).not.toContain(mine);
    expect(await visible(omar)).not.toContain(mine);
    expect(await sys(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workshop_sessions WHERE id = $1', [mine])).rows.length)).toBe(1);
  });

  it('cannot be made in someone else\'s name', async () => {
    const attempt = as(nadia, (tx) =>
      tx.query(`INSERT INTO app.workshop_sessions (workspace_id, team_id, bot_id, bot_slug, owner_id, mode) VALUES ($1, $2, $3, 'helper', $4, 'build')`, [nadia.workspaceId, ENG, botId, priya.actorId]),
    );
    expect(await code(attempt)).toBeDefined();
  });

  it('are changed by their owner, never by another person, and are not deleted by the app', async () => {
    const mine = await start(nadia, 'live');
    expect(await as(nadia, async (tx) => (await tx.query("UPDATE app.workshop_sessions SET status = 'ended' WHERE id = $1", [mine])).rowCount)).toBe(1);
    expect(await as(omar, async (tx) => (await tx.query("UPDATE app.workshop_sessions SET status = 'working' WHERE id = $1", [mine])).rowCount)).toBe(0);
    expect(await as(nadia, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.workshop_sessions WHERE id = $1', [mine])).rows[0]?.status)).toBe('ended');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.workshop_sessions WHERE id = $1', [mine])))).toBeDefined();
  });

  it('refuse a mode, a status and a record the shape does not allow', async () => {
    const mine = await start(nadia);
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.workshop_sessions SET status = 'done' WHERE id = $1", [mine])))).toBe('23514');
    expect(await code(start(nadia, 'sideways'))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.workshop_sessions SET history = to_jsonb(repeat('x', 500000)) WHERE id = $1`, [mine])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.workshop_sessions SET entries = '{}'::jsonb WHERE id = $1`, [mine])))).toBe('23514');
  });

  it('go with the bot: a bot that is deleted takes its conversations with it', async () => {
    const other = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'gone', 'agent', 'rules', 'team', repeat('b', 64), 'active') RETURNING id`,
            [omar.workspaceId, ENG],
          )
        ).rows[0]!.id,
    );
    const id = await as(
      nadia,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.workshop_sessions (workspace_id, team_id, bot_id, bot_slug, owner_id, mode) VALUES ($1, $2, $3, 'gone', (SELECT app.actor()), 'build') RETURNING id`,
            [nadia.workspaceId, ENG, other],
          )
        ).rows[0]!.id,
    );
    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [other]));
    expect(await visible(nadia)).not.toContain(id);
  });
});
