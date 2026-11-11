import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import {
  TEAM_IDS,
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  personaActor,
  personas,
  surfacesMigrationSource,
  tasksMigrationSource,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, lena } = personas;

// The plan card of a goal at the database (PLAN P22-03, surfaces migration 0003; pnpm test:rls): one card per goal; only a bot of the goal's team draws it, in the
// goal's own team channel, never in a thread or a direct message; the goal never changes; the message that shows it is tied once, to a message of the bot's that
// names this very card; its text is written by the system role only; and a person who cannot read the channel reads neither the card, its message, nor its history.

const WS = omar.workspaceId;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];
let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const asBot = <T>(actorId: string, runId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: actorId, workspaceId: WS, ...(runId ? { runId } : {}) } as Actor, fn, { pool: appPool });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const SOURCE = 'root = GoalCard("g", "G-1 · Ship it", null)\n';
type Bot = { id: string; actor: string; run: string };
let pub = '';
let priv = '';
let other = '';
let bot: Bot;
let sibling: Bot;
let stranger: Bot;

const newChannel = (name: string, isPrivate: boolean, members: Persona[], team: string = ENG): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, 'channel', $4, $5) RETURNING id", [WS, team, name, isPrivate, omar.actorId])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const makeBot = (slug: string, team: string): Promise<Bot> =>
  sys(async (tx) => {
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
       VALUES ($1, $2, $3, $3, '', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runner": "default"}') RETURNING id`,
      [WS, team, slug],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, b.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [team, a.rows[0]!.id, WS]);
    const r = await tx.query<{ id: string }>("INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status) VALUES ($1, $2, $3, 'mention', 'running') RETURNING id", [WS, b.rows[0]!.id, team]);
    return { id: b.rows[0]!.id, actor: a.rows[0]!.id, run: r.rows[0]!.id };
  });
const newGoal = (channel: string | null, team: string = ENG): Promise<string> =>
  sys(async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.goals (workspace_id, team_id, title, created_by, channel_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [WS, team, 'A goal', omar.actorId, channel])).rows[0]!.id);
const draw = (b: Bot, channel: string, goal: string, extra: { thread?: string; message?: string } = {}): Promise<string> =>
  asBot(b.actor, b.run, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by, goal_id, thread_root_id, message_id)
         VALUES ($1, $2, $3, 'G-1 · Ship it', $4, $5, $6, $7, $8) RETURNING id`,
        [WS, channel, b.id, SOURCE, b.actor, goal, extra.thread ?? null, extra.message ?? null],
      )
    ).rows[0]!.id,
  );
const post = (channel: string, author: string, surfaceRef: string | null): Promise<string> =>
  sys(async (tx) => {
    const meta = JSON.stringify(surfaceRef === null ? {} : { surfaceRef });
    const r = await tx.query<{ id: string }>('INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta) VALUES ($1, $2, $3, $4, $4, $5::jsonb) RETURNING id', [WS, channel, author, 'Goal G-1 · planned', meta]);
    return r.rows[0]!.id;
  });
const row = (id: string) => sys(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.surfaces WHERE id = $1', [id])).rows[0]!);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, approvalsMigrationSource, tasksMigrationSource, surfacesMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  pub = await newChannel('plan-open', false, []);
  priv = await newChannel('plan-private', true, [nadia, rafi]);
  other = await newChannel('plan-other', false, []);
  bot = await makeBot('plan-bot', ENG);
  sibling = await makeBot('plan-sibling', ENG);
  stranger = await makeBot('plan-stranger', SUPPORT);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the tables', () => {
  it('still pass the RLS harness with the two new columns and the unique index', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('drawing the plan card', () => {
  it('a bot of the goal\'s team draws it in the goal\'s own team channel, as itself; the message is not chosen by the caller', async () => {
    const goal = await newGoal(pub);
    const stray = await post(pub, bot.actor, null);
    const id = await draw(bot, pub, goal, { message: stray });
    expect(await row(id)).toMatchObject({ goal_id: goal, channel_id: pub, bot_id: bot.id, created_by: bot.actor, version: 1, message_id: null, thread_root_id: null, team_id: ENG });
  });

  it('is one card per goal: a second one for the same goal, by the same bot or another bot of the team, is refused by the unique index', async () => {
    const goal = await newGoal(pub);
    await draw(bot, pub, goal);
    expect(await code(draw(bot, pub, goal))).toBe('23505');
    expect(await code(draw(sibling, pub, goal))).toBe('23505');
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE goal_id = $1', [goal])).rows.length)).toBe(1);
  });

  it('is refused for a goal of another team, a bot of another team, another channel than the goal\'s, and a goal with no channel', async () => {
    const theirs = await newGoal(await newChannel('plan-support', false, [], SUPPORT), SUPPORT);
    expect(await code(draw(bot, pub, theirs))).toBe('23514');
    const ours = await newGoal(pub);
    expect(await code(draw(stranger, pub, ours))).toBe('23514');
    expect(await code(draw(bot, other, ours))).toBe('23514');
    expect(await code(draw(bot, pub, await newGoal(null)))).toBe('23514');
  });

  it('is refused in a thread, in a direct message and in a conversation with a bot (even for the system role), and for a bot that cannot post in the channel', async () => {
    const goal = await newGoal(pub);
    const root = await post(pub, nadia.actorId, null);
    expect(await code(draw(bot, pub, goal, { thread: root }))).toBe('23514');
    const dm = await sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, kind, private, dm_key, created_by) VALUES ($1, 'dm', true, $2, $3) RETURNING id", [WS, `${nadia.personId}:${rafi.personId}`, nadia.actorId])).rows[0]!.id);
    const dmGoal = await newGoal(dm);
    const insert = (channel: string, g: string) =>
      sys((tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by, goal_id) VALUES ($1, $2, $3, 'x', $4, $5, $6)`, [WS, channel, bot.id, SOURCE, bot.actor, g]));
    expect(await code(insert(dm, dmGoal))).toBe('23514');
    const talk = await sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, bot_id, created_by) VALUES ($1, $2, 'plan-talk', 'bot_conversation', true, $3, $4) RETURNING id", [WS, ENG, bot.id, nadia.actorId])).rows[0]!.id);
    expect(await code(insert(talk, await newGoal(talk)))).toBe('23514');
    // a private channel the bot has no seat in: the policy of 0001 holds first
    expect(await code(draw(bot, priv, await newGoal(priv)))).toBe('42501');
    // a person never draws one
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by, goal_id) VALUES ($1, $2, $3, 'x', $4, $5, $6)`, [WS, pub, bot.id, SOURCE, nadia.actorId, goal])))).toBe('42501');
  });
});

describe('changing a plan card', () => {
  let goal = '';
  let id = '';
  let message = '';
  beforeAll(async () => {
    goal = await newGoal(pub);
    id = await draw(bot, pub, goal);
    message = await post(pub, bot.actor, id);
  });

  it('the goal of a card never changes, for the bot, a person or the system', async () => {
    const next = await newGoal(pub);
    expect(await code(asBot(bot.actor, bot.run, (tx) => tx.query('UPDATE app.surfaces SET goal_id = $2 WHERE id = $1', [id, next])))).toBe('23514');
    expect(await code(asBot(bot.actor, bot.run, (tx) => tx.query('UPDATE app.surfaces SET goal_id = NULL WHERE id = $1', [id])))).toBe('23514');
    expect(await code(sys((tx) => tx.query('UPDATE app.surfaces SET goal_id = $2 WHERE id = $1', [id, next])))).toBe('23514');
    expect((await row(id))['goal_id']).toBe(goal);
  });

  it('the bot that drew it cannot rewrite its text, title or thread; the system role can (the version goes up)', async () => {
    expect(await code(asBot(bot.actor, bot.run, (tx) => tx.query(`UPDATE app.surfaces SET source = 'root = Text("mine")' WHERE id = $1`, [id])))).toBe('42501');
    expect(await code(asBot(bot.actor, bot.run, (tx) => tx.query(`UPDATE app.surfaces SET title = 'mine' WHERE id = $1`, [id])))).toBe('42501');
    expect((await row(id))['source']).toBe(SOURCE);
    await sys((tx) => tx.query(`UPDATE app.surfaces SET title = 'G-1 · Renamed' WHERE id = $1`, [id]));
    expect(await row(id)).toMatchObject({ title: 'G-1 · Renamed', version: 1 });
    await sys((tx) => tx.query(`UPDATE app.surfaces SET source = $2 WHERE id = $1`, [id, 'root = GoalCard("g", "G-1 · Renamed", null)\n']));
    expect((await row(id))['version']).toBe(2);
  });

  it('the message is tied once, by the bot, to a message of the channel that names this card and is the bot\'s own', async () => {
    const otherCard = await draw(bot, pub, await newGoal(pub));
    const wrongRef = await post(pub, bot.actor, otherCard);
    const noRef = await post(pub, bot.actor, null);
    const notMine = await post(pub, nadia.actorId, id);
    const elsewhere = await post(other, bot.actor, id);
    const tie = (m: string | null) => asBot(bot.actor, bot.run, (tx) => tx.query('UPDATE app.surfaces SET message_id = $2 WHERE id = $1', [id, m]));
    for (const bad of [wrongRef, noRef, notMine, elsewhere]) expect(await code(tie(bad))).toBe('23514');
    expect((await row(id))['message_id']).toBeNull();
    // a person does not tie it, even to the right message
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.surfaces SET message_id = $2 WHERE id = $1', [id, message])))).toBe('23514');
    expect((await row(id))['message_id']).toBeNull();
    expect(await code(tie(message))).toBeUndefined();
    expect((await row(id))['message_id']).toBe(message);
    // set once: not changed, not cleared, not tied again
    expect(await code(tie(noRef))).toBe('23514');
    expect(await code(tie(null))).toBe('23514');
    expect(await code(tie(message))).toBeUndefined();
    expect((await row(id))['message_id']).toBe(message);
  });

  it('a card goes when its goal goes; the message stays as a message', async () => {
    const g = await newGoal(pub);
    const s = await draw(bot, pub, g);
    const m = await post(pub, bot.actor, s);
    await asBot(bot.actor, bot.run, (tx) => tx.query('UPDATE app.surfaces SET message_id = $2 WHERE id = $1', [s, m]));
    await sys((tx) => tx.query('DELETE FROM app.goals WHERE id = $1', [g]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE id = $1', [s])).rows.length)).toBe(0);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.messages WHERE id = $1', [m])).rows.length)).toBe(1);
  });
});

describe('who reads a plan card', () => {
  let goal = '';
  let card = '';
  let message = '';
  beforeAll(async () => {
    // a card in a private channel, made the way the tool makes it but by the system role (the bot has no seat in a private channel)
    goal = await newGoal(priv);
    card = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO app.surfaces (workspace_id, channel_id, bot_id, title, source, created_by, goal_id) VALUES ($1, $2, $3, 'G-1 · Private', $4, $5, $6) RETURNING id`, [WS, priv, bot.id, SOURCE, bot.actor, goal])).rows[0]!.id);
    message = await post(priv, bot.actor, card);
    await sys((tx) => tx.query('UPDATE app.surfaces SET message_id = $2 WHERE id = $1', [card, message]));
    await sys((tx) => tx.query(`INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version, payload) VALUES ($1, $2, $3, $4, 'render', 1, '{"goal":true}')`, [card, WS, priv, bot.actor]));
  });

  it('a member of the private channel reads the card, its message and its history', async () => {
    for (const member of [nadia, rafi]) {
      expect(await as(member, async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE id = $1', [card])).rows.length), member.key).toBe(1);
      expect(await as(member, async (tx) => (await tx.query('SELECT 1 FROM app.messages WHERE id = $1', [message])).rows.length), member.key).toBe(1);
      expect(await as(member, async (tx) => (await tx.query('SELECT 1 FROM app.surface_events WHERE surface_id = $1', [card])).rows.length), member.key).toBe(1);
    }
  });

  it('a person who is not in the channel reads none of it, the goal id and the message id included; an admin who is not a member too', async () => {
    for (const outsider of [omar, sameera, lena]) {
      expect(await as(outsider, async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE id = $1 OR goal_id = $2 OR message_id = $3', [card, goal, message])).rows.length), outsider.key).toBe(0);
      expect(await as(outsider, async (tx) => (await tx.query('SELECT 1 FROM app.messages WHERE id = $1', [message])).rows.length), outsider.key).toBe(0);
      expect(await as(outsider, async (tx) => (await tx.query('SELECT 1 FROM app.surface_events WHERE surface_id = $1', [card])).rows.length), outsider.key).toBe(0);
    }
  });

  it('a bot of the team that has no seat in the private channel reads none of it either', async () => {
    expect(await asBot(sibling.actor, sibling.run, async (tx) => (await tx.query('SELECT 1 FROM app.surfaces WHERE goal_id = $1', [goal])).rows.length)).toBe(0);
  });
});
