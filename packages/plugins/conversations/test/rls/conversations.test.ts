import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import {
  answerMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  conversationsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONVERSATION_COLUMNS, toConversation, type ConversationRow } from '../../src/rows.ts';

// P5-16: who can open a conversation with a bot, who can read it, what the bot sees of it, and the index that records its visibility. The
// rows exist through the system role; every assertion runs as a persona (or as a bot inside a run) through the app pool, which is what a
// request is.

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let botId = '';
let botActorId = '';
let disabledBotId = '';
let otherBotId = '';
let otherBotActorId = '';

const open = (p: Persona, bot = botId): Promise<{ channel_id: string; created: boolean }> =>
  as(p, async (tx) => (await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.conversations_open($1::uuid)', [bot])).rows[0]!);

const say = (channel: string, author: string, text: string, root: string | null = null): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
          [omar.workspaceId, channel, author, text, root],
        )
      ).rows[0]!.id,
  );

const botRun = (bot: string, channel: string | null, status = 'running', trigger = 'conversation', asker: string = nadia.actorId): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status, ended_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text, CASE WHEN $7::text = 'running' THEN NULL ELSE now() END) RETURNING id`,
          [omar.workspaceId, bot, ENG, trigger, asker, channel, status],
        )
      ).rows[0]!.id,
  );

/** What a bot actor in a run may read / post: the visible set of the run's own transaction. */
const botSees = (actorId: string, runId: string | undefined, perm: 'read' | 'post'): Promise<string[]> =>
  withActor(
    { kind: 'bot', id: actorId, workspaceId: omar.workspaceId, ...(runId ? { runId } : {}) } as Actor,
    async (tx) => ((await tx.query<{ ids: string[] }>('SELECT app.visible_channel_ids($1) AS ids', [perm])).rows[0]!.ids),
    { pool: appPool },
  );

beforeAll(async () => {
  db = await createTestDatabase({
    // the sharing door reads the answer plugin's share log (`app.answer_shares`), whose functions read files and the repo index
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      repoGitMigrationSource,
      botsMigrationSource,
      conversationsMigrationSource,
      answerMigrationSource,
    ],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const makeBot = async (tx: Tx, slug: string, status: string): Promise<{ id: string; actor: string }> => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, $4, '', 'agent', 'rules', 'team', repeat('a', 64), $5) RETURNING id`,
      [omar.workspaceId, ENG, slug, slug, status],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id]);
    return { id: bot.rows[0]!.id, actor: actor.rows[0]!.id };
  };
  await sys(async (tx) => {
    const brain = await makeBot(tx, 'brain', 'active');
    botId = brain.id;
    botActorId = brain.actor;
    disabledBotId = (await makeBot(tx, 'sleeper', 'disabled')).id;
    const other = await makeBot(tx, 'other', 'active');
    otherBotId = other.id;
    otherBotActorId = other.actor;
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the conversations table', () => {
  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'conversations')).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('app.conversations_open', () => {
  it('makes the channel and its one member together, once; the same person opening again gets the same channel', async () => {
    const first = await open(nadia);
    expect(first.created).toBe(true);
    expect(await open(nadia)).toEqual({ channel_id: first.channel_id, created: false });
    const row = (
      await sys(async (tx) =>
        (
          await tx.query<{ kind: string; private: boolean; team_id: string; name: string; bot_id: string; created_by: string; dm_key: string | null; members: string[] }>(
            `SELECT c.kind, c.private, c.team_id, c.name, c.bot_id, c.created_by, c.dm_key,
                    (SELECT array_agg(m.person_id::text) FROM app.channel_members m WHERE m.channel_id = c.id) AS members
               FROM app.channels c WHERE c.id = $1`,
            [first.channel_id],
          )
        ).rows,
      )
    )[0];
    expect(row).toEqual({ kind: 'bot_conversation', private: true, team_id: ENG, name: '', bot_id: botId, created_by: nadia.actorId, dm_key: null, members: [nadia.personId] });
  });

  it('is one channel per bot and per person: another person, and another bot, each get their own', async () => {
    const a = await open(nadia);
    const b = await open(rafi);
    const c = await open(nadia, otherBotId);
    expect(new Set([a.channel_id, b.channel_id, c.channel_id]).size).toBe(3);
    expect(b.created).toBe(true);
    expect(c.created).toBe(true);
  });

  it('refuses a guest, a person who is not on the bot’s team, a disabled bot, a bot that does not exist and a bot actor', async () => {
    expect(await code(open(lena))).toBe('42501');
    expect(await code(open(sameera))).toBe('42501');
    expect(await code(open(tariq))).toBe('42501');
    expect(await code(open(nadia, disabledBotId))).toBe('23514');
    expect(await code(open(nadia, randomUUID()))).toBe('22023');
    const asBot: Actor = { kind: 'bot', id: botActorId as Actor['id'], workspaceId: omar.workspaceId };
    expect(await code(withActor(asBot, (tx) => tx.query('SELECT * FROM app.conversations_open($1::uuid)', [botId]), { pool: appPool }))).toBe('42501');
  });

  it('is the only way in: a caller cannot insert a bot conversation channel or add themself to one', async () => {
    const mine = (await open(nadia)).channel_id;
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(`INSERT INTO app.channels (workspace_id, team_id, name, kind, private, bot_id) VALUES ($1, $2, '', 'bot_conversation', true, $3)`, [omar.workspaceId, ENG, botId]),
        ),
      ),
    ).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [mine, omar.personId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.channels_add_member($1, $2)', [mine, omar.personId])))).toBe('42501');
  });

  it('a second channel for the same bot and person cannot exist (the partial unique index)', async () => {
    await open(priya);
    expect(
      await code(
        sys((tx) =>
          tx.query(
            `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, bot_id, created_by) VALUES ($1, $2, '', 'bot_conversation', true, $3, $4)`,
            [omar.workspaceId, ENG, botId, priya.actorId],
          ),
        ),
      ),
    ).toBe('23505');
  });

  it('nobody leaves a conversation with a bot (and a person who is not its member cannot make them)', async () => {
    const mine = (await open(nadia)).channel_id;
    expect(await code(as(nadia, (tx) => tx.query('SELECT app.channels_remove_member($1, $2)', [mine, nadia.personId])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.channels_remove_member($1, $2)', [mine, nadia.personId])))).toBe('42501');
    expect(await as(nadia, async (tx) => (await tx.query('SELECT 1 FROM app.channel_members WHERE channel_id = $1', [mine])).rows.length)).toBe(1);
  });
});

describe('who reads a conversation', () => {
  it('only the asker reads the channel, its members and its messages: a lead and a workspace admin read nothing', async () => {
    const mine = (await open(nadia)).channel_id;
    const root = await say(mine, nadia.actorId, 'Is the Falcon rewrite being cancelled?');
    await say(mine, botActorId, 'No decision has been made.', root);
    const rows = (p: Persona, text: string): Promise<number> => as(p, async (tx) => (await tx.query(text, [mine])).rows.length);
    for (const who of [omar, rafi, priya, sameera, tariq, lena]) {
      expect(await rows(who, 'SELECT id FROM app.channels WHERE id = $1'), `${who.key} channel`).toBe(0);
      expect(await rows(who, 'SELECT person_id FROM app.channel_members WHERE channel_id = $1'), `${who.key} members`).toBe(0);
      expect(await rows(who, 'SELECT id FROM app.messages WHERE channel_id = $1'), `${who.key} messages`).toBe(0);
      expect(await rows(who, 'SELECT root_message_id FROM app.threads WHERE channel_id = $1'), `${who.key} threads`).toBe(0);
    }
    expect(await rows(nadia, 'SELECT id FROM app.channels WHERE id = $1')).toBe(1);
    expect(await rows(nadia, 'SELECT id FROM app.messages WHERE channel_id = $1')).toBe(2);
    // and nobody else can write into it
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'hi', 'hi')`, [omar.workspaceId, mine, rafi.actorId])))).toBe('42501');
  });

  it('a person who leaves the bot’s team stops reading their conversations (their membership row stays)', async () => {
    const mine = (await open(rafi)).channel_id;
    expect(await as(rafi, async (tx) => (await tx.query('SELECT id FROM app.channels WHERE id = $1', [mine])).rows.length)).toBe(1);
    await sys((tx) => tx.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [ENG, rafi.actorId]));
    expect(await as(rafi, async (tx) => (await tx.query('SELECT id FROM app.channels WHERE id = $1', [mine])).rows.length)).toBe(0);
    await sys((tx) => tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, rafi.actorId, omar.workspaceId]));
    expect(await as(rafi, async (tx) => (await tx.query('SELECT id FROM app.channels WHERE id = $1', [mine])).rows.length)).toBe(1);
  });
});

describe('what the bot sees of a conversation channel (channels 0006)', () => {
  it('only the one its own live run answers in, for reading and for posting', async () => {
    const nadias = (await open(nadia)).channel_id;
    const priyas = (await open(priya)).channel_id;
    const run = await botRun(botId, nadias);
    expect(await botSees(botActorId, run, 'read')).toContain(nadias);
    expect(await botSees(botActorId, run, 'post')).toContain(nadias);
    // not the same bot's channel with another person, and nothing outside a run
    expect(await botSees(botActorId, run, 'read')).not.toContain(priyas);
    expect(await botSees(botActorId, undefined, 'read')).not.toContain(nadias);
    expect(await botSees(botActorId, undefined, 'post')).not.toContain(nadias);
  });

  it('not another bot’s run, not a run that ended, and not a channel a run was not opened for', async () => {
    const nadias = (await open(nadia)).channel_id;
    const run = await botRun(botId, nadias);
    // the other bot, holding this run's id, is not the run's bot
    expect(await botSees(otherBotActorId, run, 'read')).not.toContain(nadias);
    const ended = await botRun(botId, nadias, 'done');
    expect(await botSees(botActorId, ended, 'read')).not.toContain(nadias);
    expect(await botSees(botActorId, ended, 'post')).not.toContain(nadias);
    // a run for the other bot's own channel with nadia is that bot's, not this one's
    const othersChannel = (await open(nadia, otherBotId)).channel_id;
    const otherRun = await botRun(otherBotId, othersChannel);
    expect(await botSees(botActorId, otherRun, 'read')).not.toContain(othersChannel);
    expect(await botSees(otherBotActorId, otherRun, 'read')).toContain(othersChannel);
    // a run with no channel (a routine) reaches no conversation
    const routine = await botRun(botId, null, 'running', 'routine');
    expect(await botSees(botActorId, routine, 'read')).not.toContain(nadias);
  });

  it('the bot posts its reply into the conversation as itself, in the asker’s thread', async () => {
    const nadias = (await open(nadia)).channel_id;
    const root = await say(nadias, nadia.actorId, 'What is the status of the release?');
    const run = await botRun(botId, nadias);
    const reply = await withActor(
      { kind: 'bot', id: botActorId as Actor['id'], workspaceId: omar.workspaceId, runId: run as never } as Actor,
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'Green.', 'Green.', $4) RETURNING id`,
            [omar.workspaceId, nadias, botActorId, root],
          )
        ).rows[0]!.id,
      { pool: appPool },
    );
    expect(reply).toBeTruthy();
    // a bot outside the run cannot
    expect(
      await code(
        withActor(
          { kind: 'bot', id: botActorId as Actor['id'], workspaceId: omar.workspaceId } as Actor,
          (tx) => tx.query(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'x', 'x', $4)`, [omar.workspaceId, nadias, botActorId, root]),
          { pool: appPool },
        ),
      ),
    ).toBe('42501');
  });
});

describe('app.conversations: the index and its visibility', () => {
  let channel = '';
  let root = '';
  let other = '';
  let copyChannel = '';
  let copyRoot = '';

  beforeAll(async () => {
    channel = (await open(nadia)).channel_id;
    root = await say(channel, nadia.actorId, 'Who owns the migration runbook?');
    const rafiChannel = (await open(rafi)).channel_id;
    other = await say(rafiChannel, rafi.actorId, 'How do I rotate the deploy key?');
    await sys(async (tx) => {
      for (const [id, person, ch] of [
        [root, nadia, channel],
        [other, rafi, rafiChannel],
      ] as const) {
        await tx.query(
          `INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, omar.workspaceId, ENG, botId, person.personId, ch],
        );
      }
      // the team channel the shared copy was posted to, and the copy
      copyChannel = (await tx.query<{ id: string }>("SELECT id FROM app.channels WHERE team_id = $1 AND kind = 'channel' LIMIT 1", [ENG])).rows[0]?.id ?? '';
    });
    if (copyChannel === '') {
      copyChannel = await sys(async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'releases-eng', 'channel', false) RETURNING id`,
            [omar.workspaceId, ENG],
          )
        ).rows[0]!.id,
      );
    }
    copyRoot = await say(copyChannel, nadia.actorId, 'Shared: who owns the migration runbook?');
  });

  const listed = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ thread_root_id: string }>('SELECT thread_root_id FROM app.conversations ORDER BY thread_root_id')).rows.map((r) => r.thread_root_id));

  it('a private conversation is read by its asker and by nobody else, an admin included', async () => {
    expect(await listed(nadia)).toEqual([root]);
    expect(await listed(rafi)).toEqual([other]);
    for (const who of [omar, priya, sameera, tariq, lena]) expect(await listed(who), who.key).toEqual([]);
  });

  it('once shared, the bot’s team reads the row (members and the admin), and nobody outside the team', async () => {
    await sys((tx) =>
      tx.query(
        `UPDATE app.conversations SET visibility = 'shared', shared_to = $2, shared_root_id = $3, shared_by = $4, shared_at = now() WHERE thread_root_id = $1`,
        [root, copyChannel, copyRoot, nadia.actorId],
      ),
    );
    expect(await listed(nadia)).toEqual([root]);
    expect(await listed(priya)).toEqual([root]);
    expect(await listed(omar)).toEqual([root]);
    // Rafi: his own private one, and Nadia's shared one
    expect((await listed(rafi)).sort()).toEqual([root, other].sort());
    for (const who of [sameera, tariq, lena]) expect(await listed(who), who.key).toEqual([]);
    // the index holds no text: a reader of the row learns nothing of the private thread
    const columns = (await sys(async (tx) => (await tx.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' AND table_schema = 'app'")).rows)).map((r) => r.column_name);
    expect(columns.filter((c) => /body|text|title|preview/.test(c))).toEqual([]);
    // and the private thread itself stays the asker's: Rafi reads the row, not the messages
    expect(await as(rafi, async (tx) => (await tx.query('SELECT id FROM app.messages WHERE id = $1', [root])).rows.length)).toBe(0);
    await sys((tx) => tx.query(`UPDATE app.conversations SET visibility = 'private', shared_to = NULL, shared_root_id = NULL, shared_by = NULL, shared_at = NULL WHERE thread_root_id = $1`, [root]));
    expect(await listed(priya)).toEqual([]);
  });

  it('a row maps into the shared Conversation entity, private and shared', async () => {
    const read = (id: string) =>
      sys(async (tx) => (await tx.query<ConversationRow>(`SELECT ${CONVERSATION_COLUMNS} FROM app.conversations WHERE thread_root_id = $1`, [id])).rows[0]!);
    expect(toConversation(await read(root))).toMatchObject({
      threadRootId: root,
      workspaceId: omar.workspaceId,
      teamId: ENG,
      botId,
      personId: nadia.personId,
      visibility: 'private',
      sharedTo: null,
      sharedRootId: null,
      sharedBy: null,
      sharedAt: null,
    });
    await sys((tx) =>
      tx.query(
        `UPDATE app.conversations SET visibility = 'shared', shared_to = $2, shared_root_id = $3, shared_by = $4, shared_at = now() WHERE thread_root_id = $1`,
        [root, copyChannel, copyRoot, nadia.actorId],
      ),
    );
    const shared = toConversation(await read(root));
    expect(shared).toMatchObject({ visibility: 'shared', sharedTo: copyChannel, sharedRootId: copyRoot, sharedBy: nadia.actorId });
    expect(shared.sharedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await sys((tx) => tx.query(`UPDATE app.conversations SET visibility = 'private', shared_to = NULL, shared_root_id = NULL, shared_by = NULL, shared_at = NULL WHERE thread_root_id = $1`, [root]));
  });

  it('a caller cannot write the index at all', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.conversations SET visibility = 'shared', shared_at = now() WHERE thread_root_id = $1`, [root])))).toBe('42501');
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(`INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
            root,
            omar.workspaceId,
            ENG,
            botId,
            nadia.personId,
            channel,
          ]),
        ),
      ),
    ).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.conversations WHERE thread_root_id = $1', [root])))).toBe('42501');
  });

  it('refuses a shape that says shared without a time, and a share target on a private row', async () => {
    expect(await code(sys((tx) => tx.query(`UPDATE app.conversations SET visibility = 'shared' WHERE thread_root_id = $1`, [root])))).toBe('23514');
    expect(await code(sys((tx) => tx.query('UPDATE app.conversations SET shared_to = $2 WHERE thread_root_id = $1', [root, copyChannel])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`UPDATE app.conversations SET visibility = 'public' WHERE thread_root_id = $1`, [root])))).toBe('23514');
  });

  it('goes with its bot (the messages stay: they are the person’s, in their own channel)', async () => {
    const temp = await sys(async (tx) => {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'temp', 'Temp', '', 'agent', 'rules', 'team', repeat('b', 64), 'active') RETURNING id`,
        [omar.workspaceId, ENG],
      );
      await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, bot.rows[0]!.id]);
      return bot.rows[0]!.id;
    });
    const lone = (await open(priya, temp)).channel_id;
    const id = await say(lone, priya.actorId, 'A question');
    await sys((tx) =>
      tx.query(`INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id,
        omar.workspaceId,
        ENG,
        temp,
        priya.personId,
        lone,
      ]),
    );
    await sys((tx) => tx.query('DELETE FROM app.bots WHERE id = $1', [temp]));
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.conversations WHERE thread_root_id = $1', [id])).rows.length)).toBe(0);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.messages WHERE id = $1', [id])).rows.length)).toBe(1);
  });
});

describe('app.conversations_mark_shared (P5-17)', () => {
  let chat = '';
  let root = '';
  let teamChannel = '';
  let copy = '';
  let otherTeamChannel = '';
  let otherTeamCopy = '';

  const mark = (p: Persona, thread: string, channel: string, message: string): Promise<boolean> =>
    as(p, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.conversations_mark_shared($1::uuid, $2::uuid, $3::uuid) AS ok', [thread, channel, message])).rows[0]!.ok);
  const stateOf = (thread: string) =>
    sys(async (tx) => (await tx.query<{ visibility: string; shared_to: string | null; shared_root_id: string | null; shared_by: string | null }>(
      'SELECT visibility, shared_to, shared_root_id, shared_by FROM app.conversations WHERE thread_root_id = $1', [thread])).rows[0]!);
  /** The log line `answer_share_record` writes when a person shares an answer of this conversation as `message` (the thing the door checks). */
  const shareLine = (message: string, channel: string, person: Persona = priya): Promise<unknown> =>
    sys(async (tx) => {
      const answer = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'An answer', 'An answer', $4) RETURNING id`,
          [omar.workspaceId, chat, botActorId, root],
        )
      ).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.answer_shares (workspace_id, message_id, kind, channel_id, shared_by, digest, copy_message_id, kept_count, masked_count, removed_count)
         VALUES ($1, $2, 'channel', $3, $4, encode(sha256($5::text::bytea), 'hex'), $5, 0, 0, 0) ON CONFLICT DO NOTHING`,
        [omar.workspaceId, answer, channel, person.personId, message],
      );
    });
  const reset = (thread: string): Promise<unknown> =>
    sys((tx) => tx.query(`UPDATE app.conversations SET visibility = 'private', shared_to = NULL, shared_root_id = NULL, shared_by = NULL, shared_at = NULL WHERE thread_root_id = $1`, [thread]));

  beforeAll(async () => {
    chat = (await open(priya)).channel_id;
    root = await say(chat, priya.actorId, 'Priya asks something');
    await sys(async (tx) => {
      await tx.query(
        `INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [root, omar.workspaceId, ENG, botId, priya.personId, chat],
      );
      teamChannel = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'shared-to-eng', 'channel', false) RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id;
      otherTeamChannel = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'shared-to-marketing', 'channel', false) RETURNING id`,
          [omar.workspaceId, TEAM_IDS.Marketing],
        )
      ).rows[0]!.id;
    });
    copy = await say(teamChannel, priya.actorId, 'A masked copy');
    otherTeamCopy = await say(otherTeamChannel, priya.actorId, 'A masked copy elsewhere');
    await shareLine(copy, teamChannel);
    await shareLine(otherTeamCopy, otherTeamChannel);
  });

  it('marks the asker’s own conversation shared, through a copy that is theirs, in a channel of the bot’s team', async () => {
    expect(await mark(priya, root, teamChannel, copy)).toBe(true);
    expect(await stateOf(root)).toEqual({ visibility: 'shared', shared_to: teamChannel, shared_root_id: copy, shared_by: priya.actorId });
    await reset(root);
  });

  it('refuses everybody but the asker, a copy that is not theirs, and a channel they cannot post in', async () => {
    // somebody else's conversation is theirs to change in no way: nothing is marked, even with a message of their own and a log line of their own
    const nadias = await say(teamChannel, nadia.actorId, 'Nadia’s own message');
    await shareLine(nadias, teamChannel, nadia);
    expect(await code(mark(nadia, root, teamChannel, nadias))).toBe('42501');
    // and a message of the caller's own that was never shared from this conversation is no copy of it
    expect(await code(mark(priya, root, teamChannel, await say(teamChannel, priya.actorId, 'Priya’s own, unrelated message')))).toBe('42501');
    expect((await stateOf(root)).visibility).toBe('private');
    // a message that is not the caller's own
    expect(await code(mark(priya, root, teamChannel, await say(teamChannel, nadia.actorId, 'Not Priya’s')))).toBe('42501');
    // a message in another channel than the one named
    expect(await code(mark(priya, root, teamChannel, otherTeamCopy))).toBe('42501');
    // a guest shares nothing
    expect(await code(mark(lena, root, teamChannel, copy))).toBe('42501');
    // a bot cannot
    await expect(
      withActor({ kind: 'bot', id: botActorId, workspaceId: omar.workspaceId } as Actor, async (tx) => tx.query('SELECT app.conversations_mark_shared($1::uuid, $2::uuid, $3::uuid)', [root, teamChannel, copy]), { pool: appPool }),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await stateOf(root)).visibility).toBe('private');
  });

  it('a private room of the bot’s own team leaves it private too: the team would be shown a row it cannot open', async () => {
    const room = await sys(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'private-room-eng', 'channel', true) RETURNING id`,
          [omar.workspaceId, ENG],
        )
      ).rows[0]!.id,
    );
    await sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [room, priya.personId]));
    const roomCopy = await say(room, priya.actorId, 'A masked copy in a room');
    await shareLine(roomCopy, room);
    expect(await mark(priya, root, room, roomCopy)).toBe(false);
    expect((await stateOf(root)).visibility).toBe('private');
  });

  it('deleting the copy makes the conversation private again, and not before; an older live copy takes the mark over', async () => {
    const older = await say(teamChannel, priya.actorId, 'An older copy');
    await shareLine(older, teamChannel);
    expect(await mark(priya, root, teamChannel, older)).toBe(true);
    expect(await mark(priya, root, teamChannel, copy)).toBe(true);
    expect((await stateOf(root)).shared_root_id).toBe(copy);
    // a message that is not the copy being deleted changes nothing
    const other = await say(teamChannel, nadia.actorId, 'Something else');
    await sys((tx) => tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [other]));
    expect((await stateOf(root)).shared_root_id).toBe(copy);
    // the newest copy goes: the conversation is still shared, through the older one that is live
    await sys((tx) => tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [copy]));
    expect(await stateOf(root)).toMatchObject({ visibility: 'shared', shared_to: teamChannel, shared_root_id: older, shared_by: priya.actorId });
    // the last one goes: private again
    await sys((tx) => tx.query("UPDATE app.messages SET deleted_at = now(), body_plain = '' WHERE id = $1", [older]));
    expect(await stateOf(root)).toEqual({ visibility: 'private', shared_to: null, shared_root_id: null, shared_by: null });
  });

  it('a channel of another team leaves the conversation private (the copy is posted, the team has nothing to open)', async () => {
    expect(await mark(priya, root, otherTeamChannel, otherTeamCopy)).toBe(false);
    expect((await stateOf(root)).visibility).toBe('private');
  });

  it('is the only way a caller changes the index: a direct UPDATE is still refused', async () => {
    expect(await code(as(priya, (tx) => tx.query(`UPDATE app.conversations SET visibility = 'shared', shared_at = now() WHERE thread_root_id = $1`, [root])))).toBe('42501');
  });
});
