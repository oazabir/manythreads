import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import type { ActorId, RunId } from '@manythreads/shared';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  testClient,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-09: which bots may read a person's Personal space, and the database fact (`app.run_space_context()`) every read tool asks. The rule: a private context
// (conversation, DM) opens the asker's Personal space to the workspace Brain unless they said no, and to any other bot only when its definition lists
// `personal.read` AND the person said yes; a team context never opens it. Answered per run from the run's own row, never from anything a bot sends.

const { omar, nadia, rafi, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

interface Context {
  audience: string;
  asker_person_id: string | null;
  personal_allowed: boolean;
  personal_reason: string | null;
}
const sha = (n: number): string => String(n).repeat(64).slice(0, 64);
let brainId = '';
let helperId = '';
let rogueId = '';
let brainActor = '';
let helperActor = '';
let teamChannelId = '';
const runs: Record<string, string> = {};

async function makeBot(tx: Tx, slug: string, scope: 'team' | 'workspace', n: number, team: string = ENG): Promise<{ id: string; actor: string }> {
  const bot = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, scope)
     VALUES ($1, $2, $3, $3, 'Helps', 'agent', 'hermes', $4, $5, 'active', '{"runner": "default"}', $6) RETURNING id`,
    [omar.workspaceId, team, slug, scope === 'workspace' ? 'workspace' : 'team', sha(n), scope],
  );
  const actor = await tx.query<{ id: string }>(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`, [omar.workspaceId, bot.rows[0]!.id]);
  return { id: bot.rows[0]!.id, actor: actor.rows[0]!.id };
}

async function makeRun(tx: Tx, key: string, botId: string, trigger: string, asker: string | null, channelId: string | null, team: string = ENG): Promise<void> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`,
    [omar.workspaceId, botId, team, trigger, asker, channelId],
  );
  runs[key] = r.rows[0]!.id;
}

/** The context as the run's bot sees it, or as its asker does. */
const contextOf = async (runKey: string, actorId: string, workspaceId = omar.workspaceId): Promise<Context | undefined> =>
  withActor(
    { kind: actorId === nadia.actorId || actorId === lena.actorId || actorId === rafi.actorId ? 'person' : 'bot', id: actorId as ActorId, workspaceId, runId: runs[runKey] as RunId },
    async (tx) => (await tx.query<Context>('SELECT audience, asker_person_id, personal_allowed, personal_reason FROM app.run_space_context()')).rows[0],
    { pool: appPool },
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    teamChannelId = (
      await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, name, kind) VALUES ($1, $2, 'consent-room', 'channel') RETURNING id`, [omar.workspaceId, ENG])
    ).rows[0]!.id;
    const brain = await makeBot(tx, 'brain', 'workspace', 1);
    brainId = brain.id;
    brainActor = brain.actor;
    const helper = await makeBot(tx, 'helper', 'team', 2);
    helperId = helper.id;
    helperActor = helper.actor;
    // a team bot that merely calls itself "brain": its slug does not make it the Brain
    const rogue = await makeBot(tx, 'brain', 'team', 3, TEAM_IDS.Marketing);
    rogueId = rogue.id;
    // helper's definition lists personal.read
    await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read')`, [ENG, helperActor]);
    await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read')`, [TEAM_IDS.Marketing, rogue.actor]);
    await makeRun(tx, 'brainConv', brain.id, 'conversation', nadia.actorId, null);
    await makeRun(tx, 'brainTeam', brain.id, 'mention', nadia.actorId, teamChannelId);
    await makeRun(tx, 'helperConv', helper.id, 'conversation', nadia.actorId, null);
    await makeRun(tx, 'helperNoAsker', helper.id, 'routine', null, null);
    await makeRun(tx, 'rogueConv', rogue.id, 'conversation', nadia.actorId, null, TEAM_IDS.Marketing);
    await makeRun(tx, 'brainGuest', brain.id, 'conversation', lena.actorId, null);
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('bot_personal_consents (P20-09)', () => {
  it('is the person\'s own: nobody else reads or writes their answers, an admin included', async () => {
    await as(nadia, (tx) => tx.query(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [nadia.personId, helperId, omar.workspaceId]));
    const count = async (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.bot_personal_consents')).rowCount ?? 0);
    expect(await count(nadia)).toBe(1);
    expect(await count(rafi)).toBe(0);
    expect(await count(omar)).toBe(0);
    // a row for someone else is refused; so is changing or deleting another person's
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [nadia.personId, brainId, omar.workspaceId])))).toBe('42501');
    await as(rafi, (tx) => tx.query(`UPDATE app.bot_personal_consents SET allowed = false`));
    await as(omar, (tx) => tx.query(`DELETE FROM app.bot_personal_consents`));
    expect(await count(nadia)).toBe(1);
    await as(nadia, (tx) => tx.query(`DELETE FROM app.bot_personal_consents`));
    expect(await count(nadia)).toBe(0);
  });

  it('only the system role sets a bot\'s scope: a team lead\'s definition cannot make a Brain', async () => {
    const rows = await sys(async (tx) => (await tx.query<{ slug: string; scope: string }>(`SELECT slug, scope FROM app.bots WHERE id = ANY ($1::uuid[]) ORDER BY scope`, [[brainId, rogueId]])).rows);
    expect(rows.map((r) => r.scope).sort()).toEqual(['team', 'workspace']);
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.bots SET scope = 'workspace' WHERE id = $1`, [rogueId])))).toBe('42501');
  });
});

describe('the policies of bot_personal_consents (P20-09)', () => {
  it('pass the RLS audit and call no function per row', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'bot_personal_consents')).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('app.run_space_context() (P20-09)', () => {
  it('gives the workspace Brain the asker\'s Personal space in a conversation, with no answer given', async () => {
    const c = await contextOf('brainConv', brainActor);
    expect(c).toMatchObject({ audience: 'personal', asker_person_id: nadia.personId, personal_allowed: true, personal_reason: null });
    // the asker gets the same answer as the bot (the run is theirs too)
    expect(await contextOf('brainConv', nadia.actorId)).toMatchObject({ personal_allowed: true });
  });

  it('never opens Personal in a team context, whoever asked', async () => {
    expect(await contextOf('brainTeam', brainActor)).toMatchObject({ audience: 'team', personal_allowed: false, personal_reason: 'team_audience' });
    expect(await contextOf('helperNoAsker', helperActor)).toMatchObject({ audience: 'team', personal_allowed: false });
  });

  it('keeps Personal shut for any other bot until its definition asks AND the person says yes', async () => {
    // helper lists personal.read but nobody has said yes
    expect(await contextOf('helperConv', helperActor)).toMatchObject({ personal_allowed: false, personal_reason: 'declined' });
    await as(nadia, (tx) => tx.query(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [nadia.personId, helperId, omar.workspaceId]));
    expect(await contextOf('helperConv', helperActor)).toMatchObject({ personal_allowed: true, personal_reason: null });
    // withdrawn: the very next call sees it
    await as(nadia, (tx) => tx.query(`UPDATE app.bot_personal_consents SET allowed = false WHERE bot_id = $1`, [helperId]));
    expect(await contextOf('helperConv', helperActor)).toMatchObject({ personal_allowed: false, personal_reason: 'declined' });
    // a yes does not help a bot whose definition does not list personal.read
    await sys((tx) => tx.query(`DELETE FROM app.capability_grants WHERE actor_id = $1 AND capability = 'personal.read'`, [helperActor]));
    await as(nadia, (tx) => tx.query(`UPDATE app.bot_personal_consents SET allowed = true WHERE bot_id = $1`, [helperId]));
    expect(await contextOf('helperConv', helperActor)).toMatchObject({ personal_allowed: false, personal_reason: 'not_requested' });
  });

  it('lets the person switch the Brain off, and on again', async () => {
    await as(nadia, (tx) => tx.query(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, false)`, [nadia.personId, brainId, omar.workspaceId]));
    expect(await contextOf('brainConv', brainActor)).toMatchObject({ personal_allowed: false, personal_reason: 'declined' });
    await as(nadia, (tx) => tx.query(`UPDATE app.bot_personal_consents SET allowed = true WHERE bot_id = $1`, [brainId]));
    expect(await contextOf('brainConv', brainActor)).toMatchObject({ personal_allowed: true });
  });

  it('does not treat a team bot that calls itself "brain" as the Brain', async () => {
    // it lists personal.read but has no yes: shut. (Its slug is only a name.)
    expect(await contextOf('rogueConv', (await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [rogueId])).rows[0]!.id)))).toMatchObject({ personal_allowed: false, personal_reason: 'declined' });
  });

  it('gives a guest no Personal space', async () => {
    expect(await contextOf('brainGuest', brainActor)).toMatchObject({ personal_allowed: false, personal_reason: 'no_personal_space', asker_person_id: null });
  });

  it('answers nobody but the run\'s own bot or asker, and nothing when the run is over', async () => {
    // another person in the same workspace sees nothing
    expect(await contextOf('brainConv', rafi.actorId)).toBeUndefined();
    // a transaction with no run sees nothing
    expect(await as(nadia, async (tx) => (await tx.query('SELECT 1 FROM app.run_space_context()')).rowCount)).toBe(0);
    await sys((tx) => tx.query(`UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1`, [runs['brainConv']]));
    expect(await contextOf('brainConv', brainActor)).toBeUndefined();
  });
});
