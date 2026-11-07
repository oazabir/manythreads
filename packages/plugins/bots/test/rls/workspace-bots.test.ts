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
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-07: the one Brain of the workspace is a bot with no team. The row may have a NULL team (only with scope = 'workspace'), a run of it keeps the CONTEXT team,
// the workspace reads it and its stored definition, and the system role alone writes either.

const { omar, nadia, lena, sameera } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
const sha = (n: number): string => String(n).repeat(64).slice(0, 64);

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let brainId = '';
let brainActor = '';
let teamBotId = '';
let channelId = '';

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    channelId = (await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, name, kind) VALUES ($1, $2, 'wb-room', 'channel') RETURNING id`, [omar.workspaceId, ENG])).rows[0]!.id;
    brainId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, scope)
         VALUES ($1, NULL, 'brain', 'Brain', 'Remembers', 'agent', 'hermes', 'workspace', $2, 'active', 'workspace') RETURNING id`,
        [omar.workspaceId, sha(1)],
      )
    ).rows[0]!.id;
    brainActor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`, [omar.workspaceId, brainId])).rows[0]!.id;
    teamBotId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'coder', 'Coder', 'Codes', 'agent', 'hermes', 'team', $3, 'active') RETURNING id`,
        [omar.workspaceId, ENG, sha(2)],
      )
    ).rows[0]!.id;
    await tx.query(`INSERT INTO app.workspace_bot_definitions (workspace_id, slug, version, sha, content) VALUES ($1, 'brain', 1, $2, '---\nschema: 1\n---')`, [omar.workspaceId, sha(1)]);
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('a bot with no team (P20-07)', () => {
  it('is allowed only for scope = workspace, and only one per slug', async () => {
    const insert = (slug: string, scope: 'team' | 'workspace', team: string | null): Promise<unknown> =>
      sys((tx) =>
        tx.query(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, scope)
           VALUES ($1, $2, $3, $3, 'x', 'agent', 'hermes', $4, $5, 'active', $6)`,
          [omar.workspaceId, team, slug, scope === 'workspace' ? 'workspace' : 'team', sha(3), scope],
        ),
      );
    // a team bot without a team is refused (check_violation); a second workspace bot of the same name too (unique_violation)
    expect(await code(insert('no-team', 'team', null))).toBe('23514');
    expect(await code(insert('brain', 'workspace', null))).toBe('23505');
    expect(await code(insert('other', 'workspace', null))).toBeUndefined();
    // a workspace bot that still names a team (the rows written before this migration) stays valid
    expect(await code(insert('legacy', 'workspace', ENG))).toBeUndefined();
  });

  it('is read by every member of the workspace and by no guest; only the system role writes it', async () => {
    const seen = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ slug: string }>(`SELECT slug FROM app.bots WHERE scope = 'workspace' AND team_id IS NULL AND slug = 'brain'`)).rows.map((r) => r.slug));
    expect(await seen(nadia)).toEqual(['brain']);
    expect(await seen(sameera)).toEqual(['brain']);
    expect(await seen(omar)).toEqual(['brain']);
    expect(await seen(lena)).toEqual([]);
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [brainId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.bots (workspace_id, slug, name, role, kind, runtime, visibility, definition_sha, status, scope) VALUES ($1, 'mine', 'm', 'x', 'agent', 'hermes', 'workspace', $2, 'active', 'workspace')`, [omar.workspaceId, sha(4)])))).toBe('42501');
  });

  it('keeps the actor lookup for the roster: members get the Brain\'s actor id, a guest none', async () => {
    const ids = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ actor_id: string }>('SELECT actor_id FROM app.workspace_bot_actor_ids()')).rows.map((r) => r.actor_id));
    expect(await ids(nadia)).toContain(brainActor);
    expect(await ids(lena)).toEqual([]);
  });
});

describe('a pairing token for the workspace bot (P20-LV)', () => {
  const hash = (n: number): Buffer => Buffer.alloc(32, n);
  const mint = (p: Persona | null, bot: string, n: number): Promise<unknown> =>
    p === null ? sys((tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [bot, hash(n)])) : as(p, (tx) => tx.query('SELECT * FROM app.bots_pairing_mint($1, $2)', [bot, hash(n)]));

  it('is minted by the system role or a workspace admin, and by nobody else (there is no team lead to ask)', async () => {
    expect(await code(mint(nadia, brainId, 21))).toBe('42501');
    expect(await code(mint(sameera, brainId, 22))).toBe('42501');
    expect(await code(mint(null, brainId, 23))).toBeUndefined();
    expect(await code(mint(omar, brainId, 24))).toBeUndefined();
  });

  it('resolves to the bot with no team, only while the bot is active', async () => {
    const resolve = (n: number): Promise<Array<{ bot_id: string; team_id: string | null }>> => sys(async (tx) => (await tx.query<{ bot_id: string; team_id: string | null }>('SELECT * FROM app.bots_pairing_resolve($1)', [hash(n)])).rows);
    expect(await resolve(23)).toEqual([expect.objectContaining({ bot_id: brainId, team_id: null })]);
    expect(await resolve(99)).toEqual([]);
    await sys((tx) => tx.query(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [brainId]));
    expect(await resolve(23)).toEqual([]);
    expect(await code(mint(omar, brainId, 25))).toBe('55000');
    await sys((tx) => tx.query(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [brainId]));
    expect(await resolve(23)).toHaveLength(1);
  });

  it('is turned off by the system role or a workspace admin only', async () => {
    const revoke = (p: Persona | null): Promise<unknown> => (p === null ? sys((tx) => tx.query('SELECT app.bots_pairing_revoke($1)', [brainId])) : as(p, (tx) => tx.query('SELECT app.bots_pairing_revoke($1)', [brainId])));
    expect(await code(revoke(nadia))).toBe('42501');
    expect(await code(revoke(omar))).toBeUndefined();
    const live = await sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bot_pairing_tokens WHERE bot_id = $1 AND revoked_at IS NULL', [brainId])).rows[0]!.n);
    expect(live).toBe(0);
  });

  it('still refuses a person who does not manage the team of a team bot, as before', async () => {
    expect(await code(mint(sameera, teamBotId, 26))).toBe('42501');
    expect(await code(mint(nadia, teamBotId, 27))).toBe('42501');
    expect(await code(mint(omar, teamBotId, 28))).toBeUndefined();
  });
});

describe('a run of the workspace bot keeps the context team (P20-07)', () => {
  const open = (botId: string, team: string): Promise<unknown> =>
    sys((tx) => tx.query(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status) VALUES ($1, $2, $3, 'mention', 'running')`, [omar.workspaceId, botId, team]));

  it('may run in any team of its workspace; a team bot only in its own team', async () => {
    expect(await code(open(brainId, ENG))).toBeUndefined();
    expect(await code(open(brainId, MKT))).toBeUndefined();
    expect(await code(open(teamBotId, ENG))).toBeUndefined();
    expect(await code(open(teamBotId, MKT))).toBe('23503');
  });

  it('is opened by a person for a team they read, as for any bot; not for a team they cannot', async () => {
    const asker = (team: string): Promise<unknown> =>
      as(nadia, (tx) =>
        tx.query(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'conversation', $4, 'running')`, [omar.workspaceId, brainId, team, nadia.actorId]),
      );
    expect(await code(asker(ENG))).toBeUndefined();
    expect(await code(asker(MKT))).toBe('42501');
  });

  it('files the model a person picked in Chat for the workspace bot, in the context team', async () => {
    const message = await sys(async (tx) =>
      (await tx.query<{ id: string }>(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'hi', 'hi') RETURNING id`, [omar.workspaceId, channelId, nadia.actorId])).rows[0]!.id,
    );
    const pick = (bot: string): Promise<unknown> =>
      as(nadia, (tx) => tx.query(`INSERT INTO app.message_model_picks (message_id, workspace_id, team_id, bot_id, asked_by, model_alias) VALUES ($1, $2, $3, $4, $5, 'smart')`, [message, omar.workspaceId, ENG, bot, nadia.actorId]));
    expect(await code(pick(brainId))).toBeUndefined();
    // a team bot of another team is still refused
    const marketingBot = await sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'mkt-bot', 'M', 'x', 'agent', 'hermes', 'team', $3, 'active') RETURNING id`,
          [omar.workspaceId, MKT, sha(5)],
        )
      ).rows[0]!.id,
    );
    const message2 = await sys(async (tx) =>
      (await tx.query<{ id: string }>(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'hi2', 'hi2') RETURNING id`, [omar.workspaceId, channelId, nadia.actorId])).rows[0]!.id,
    );
    expect(
      await code(
        as(nadia, (tx) => tx.query(`INSERT INTO app.message_model_picks (message_id, workspace_id, team_id, bot_id, asked_by, model_alias) VALUES ($1, $2, $3, $4, $5, 'smart')`, [message2, omar.workspaceId, ENG, marketingBot, nadia.actorId])),
      ),
    ).toBe('42501');
  });
});

describe('the stored definition of a workspace bot (P20-07)', () => {
  it('is read by members and not by a guest; only the system role writes a version', async () => {
    const count = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.workspace_bot_definitions')).rowCount ?? 0);
    expect(await count(nadia)).toBe(1);
    expect(await count(lena)).toBe(0);
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.workspace_bot_definitions (workspace_id, slug, version, sha, content) VALUES ($1, 'brain', 2, $2, 'x')`, [omar.workspaceId, sha(6)])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.workspace_bot_definitions`)))).toBe('42501');
  });

  it('refuses a version of the same number twice and a sha that is not a sha', async () => {
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.workspace_bot_definitions (workspace_id, slug, version, sha, content) VALUES ($1, 'brain', 1, $2, 'x')`, [omar.workspaceId, sha(7)])))).toBe('23505');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.workspace_bot_definitions (workspace_id, slug, version, sha, content) VALUES ($1, 'brain', 9, 'nope', 'x')`, [omar.workspaceId])))).toBe('23514');
  });
});

describe('the context team of the workspace bot (P20-07)', () => {
  it('is the first team a person belongs to, and none for a person of no team', async () => {
    const team = (p: Persona): Promise<string | null> => as(p, async (tx) => (await tx.query<{ t: string | null }>('SELECT app.workspace_bot_context_team($1) AS t', [p.personId])).rows[0]!.t);
    expect(await team(nadia)).toBe(ENG);
    expect(await team(sameera)).toBe(TEAM_IDS['Customer support']);
    expect(await team(lena)).toBeNull();
  });
});

describe('the policies of the new table (P20-07)', () => {
  it('pass the RLS audit and call no function per row', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'workspace_bot_definitions')).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});
