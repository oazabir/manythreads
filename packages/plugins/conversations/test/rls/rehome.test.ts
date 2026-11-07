import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  answerMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  conversationsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-07: a person's conversation with the workspace Brain is made in their oldest team of that moment. When they leave that team the system role moves the channel (and its
// index rows and files) to their oldest remaining team, so they read and post there again; nobody else gains anything, a person of no team keeps the channel untouched, and
// nothing of the history changes id.

const { omar, nadia, rafi, tariq, priya } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const messageOf = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { message?: string }) => e.message);

let brainId = '';
let teamBotId = '';

interface Moved {
  moved_channel_id: string;
  moved_bot_id: string;
  moved_person_id: string;
  from_team_id: string;
  to_team_id: string;
}
const rehome = (person: Persona | null): Promise<Moved[]> =>
  sys(async (tx) => (await tx.query<Moved>('SELECT * FROM app.conversations_rehome($1::uuid)', [person?.personId ?? null])).rows);

const open = (p: Persona, bot = brainId): Promise<{ channel_id: string; created: boolean }> =>
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

const leave = (p: Persona, team: string): Promise<unknown> => sys((tx) => tx.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [team, p.actorId]));
const join = (p: Persona, team: string, ageDays = 0): Promise<unknown> =>
  sys((tx) =>
    tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role, created_at) VALUES ($1, $2, $3, 'member', now() - make_interval(days => $4::int))`, [team, p.actorId, omar.workspaceId, ageDays]),
  );

const channelRow = (id: string) =>
  sys(async (tx) => (await tx.query<{ team_id: string; kind: string; private: boolean; created_by: string; bot_id: string; members: string[] }>(
    `SELECT c.team_id, c.kind, c.private, c.created_by, c.bot_id, (SELECT array_agg(m.person_id::text) FROM app.channel_members m WHERE m.channel_id = c.id) AS members FROM app.channels c WHERE c.id = $1`, [id])).rows[0]!);
const sees = (p: Persona, perm: 'read' | 'post'): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ ids: string[] }>('SELECT app.visible_channel_ids($1) AS ids', [perm])).rows[0]!.ids);
const messagesOf = (p: Persona, channel: string): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.messages WHERE channel_id = $1 ORDER BY id', [channel])).rows.map((r) => r.id));
const post = (p: Persona, channel: string, text: string, root: string | null): Promise<unknown> =>
  as(p, (tx) =>
    tx.query(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, $4, $4, $5)`, [omar.workspaceId, channel, p.actorId, text, root]),
  );
const conversationRows = (channel: string) =>
  sys(async (tx) => (await tx.query<{ thread_root_id: string; team_id: string; visibility: string; shared_to: string | null; shared_at: Date | null }>(
    'SELECT thread_root_id, team_id, visibility, shared_to, shared_at FROM app.conversations WHERE channel_id = $1 ORDER BY thread_root_id', [channel])).rows);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, repoGitMigrationSource, botsMigrationSource, conversationsMigrationSource, answerMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    // the workspace Brain (no team) and an ordinary team bot of Engineering
    const brain = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, scope)
       VALUES ($1, NULL, 'brain', 'Brain', '', 'agent', 'rules', 'workspace', repeat('b', 64), 'active', 'workspace') RETURNING id`,
      [omar.workspaceId],
    );
    brainId = brain.rows[0]!.id;
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, brainId]);
    const teamBot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'helper', 'Helper', '', 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    teamBotId = teamBot.rows[0]!.id;
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, teamBotId]);
    // Priya sits in Engineering first and in Marketing later: her conversation is made in Engineering
    await tx.query(`UPDATE app.team_members SET created_at = now() - interval '3 days' WHERE team_id = $1 AND actor_id = $2`, [ENG, priya.actorId]);
    await tx.query(`UPDATE app.team_members SET created_at = now() - interval '1 day' WHERE team_id = $1 AND actor_id = $2`, [MKT, priya.actorId]);
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('a person who leaves the team their Brain conversation was made in', () => {
  let channel = '';
  let root = '';
  let reply = '';
  let runId = '';
  let fileId = '';
  let teamChannel = '';

  it('has the conversation in their oldest team, with history, a shared mark, a file and an earlier run', async () => {
    const made = await open(priya);
    expect(made.created).toBe(true);
    channel = made.channel_id;
    expect((await channelRow(channel)).team_id).toBe(ENG);
    root = await say(channel, priya.actorId, 'What did we decide about the launch?');
    reply = await say(channel, priya.actorId, 'And the date?', root);
    await sys(async (tx) => {
      teamChannel = (
        await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'general', 'channel', false) RETURNING id`, [omar.workspaceId, ENG])
      ).rows[0]!.id;
      const copy = (await tx.query<{ id: string }>(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'a copy', 'a copy') RETURNING id`, [omar.workspaceId, teamChannel, priya.actorId])).rows[0]!.id;
      await tx.query(
        `INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id, visibility, shared_to, shared_root_id, shared_by, shared_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'shared', $7, $8, $9, now())`,
        [root, omar.workspaceId, ENG, brainId, priya.personId, channel, teamChannel, copy, priya.actorId],
      );
      fileId = (await tx.query<{ id: string }>(
        `INSERT INTO app.files (workspace_id, team_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
         VALUES ($1, $2, $3, '/chat/', 'notes.txt', 'blob-1', 3, 'text/plain', repeat('a', 64), $4) RETURNING id`, [omar.workspaceId, ENG, channel, priya.actorId])).rows[0]!.id;
      runId = (await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status, ended_at)
         VALUES ($1, $2, $3, 'conversation', $4, $5, 'done', now()) RETURNING id`, [omar.workspaceId, brainId, ENG, priya.actorId, channel])).rows[0]!.id;
    });
    expect((await sees(priya, 'post')).includes(channel)).toBe(true);
  });

  it('is stranded the moment they leave: they cannot read or post, and opening the conversation says it is moving instead of handing back the channel', async () => {
    await leave(priya, ENG);
    expect((await sees(priya, 'read')).includes(channel)).toBe(false);
    expect(await messagesOf(priya, channel)).toEqual([]);
    expect(await code(post(priya, channel, 'hello?', root))).toBe('42501');
    expect(await code(open(priya))).toBe('23514');
    expect(await messageOf(open(priya))).toBe('your conversation is moving to your current team; try again in a moment');
  });

  it('is moved by the system step: channel, index rows, file and the shared mark, in one go, answering what moved', async () => {
    const moved = await rehome(priya);
    expect(moved).toEqual([{ moved_channel_id: channel, moved_workspace_id: omar.workspaceId, moved_bot_id: brainId, moved_person_id: priya.personId, from_team_id: ENG, to_team_id: MKT }]);
    const row = await channelRow(channel);
    expect(row).toEqual({ team_id: MKT, kind: 'bot_conversation', private: true, created_by: priya.actorId, bot_id: brainId, members: [priya.personId] });
    const indexed = await conversationRows(channel);
    expect(indexed).toEqual([{ thread_root_id: root, team_id: MKT, visibility: 'private', shared_to: null, shared_at: null }]);
    const file = await sys(async (tx) => (await tx.query<{ team_id: string; channel_id: string }>('SELECT team_id, channel_id FROM app.files WHERE id = $1', [fileId])).rows[0]!);
    expect(file).toEqual({ team_id: MKT, channel_id: channel });
    // the run keeps the team it ran in
    expect(await sys(async (tx) => (await tx.query<{ team_id: string }>('SELECT team_id FROM app.bot_runs WHERE id = $1', [runId])).rows[0]!.team_id)).toBe(ENG);
  });

  it('reads the whole history again, under the same ids, and posts in the same thread', async () => {
    expect((await sees(priya, 'read')).includes(channel)).toBe(true);
    expect((await sees(priya, 'post')).includes(channel)).toBe(true);
    expect(await messagesOf(priya, channel)).toEqual([root, reply].sort());
    await post(priya, channel, 'One more thing', root);
    const thread = await as(priya, async (tx) => (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.messages WHERE thread_root_id = $1', [root])).rows[0]!.n);
    expect(thread).toBe('2');
    // the door answers with the same channel, not a new one
    expect(await open(priya)).toEqual({ channel_id: channel, created: false });
  });

  it('gives nobody else anything: not the team they left, not the team they moved to, not its lead, not a workspace admin', async () => {
    for (const other of [rafi, tariq, omar, nadia]) {
      expect((await sees(other, 'read')).includes(channel), other.key).toBe(false);
      expect(await messagesOf(other, channel), other.key).toEqual([]);
      expect(await code(post(other, channel, 'let me in', root)), other.key).toBe('42501');
    }
    const members = await as(tariq, async (tx) => (await tx.query('SELECT 1 FROM app.channel_members WHERE channel_id = $1', [channel])).rows.length);
    expect(members).toBe(0);
    const indexRows = await as(tariq, async (tx) => (await tx.query('SELECT 1 FROM app.conversations WHERE channel_id = $1', [channel])).rows.length);
    expect(indexRows).toBe(0);
    // and a person cannot run the step themselves, nor move a channel by a plain update
    expect(await code(as(priya, (tx) => tx.query('SELECT * FROM app.conversations_rehome($1::uuid)', [priya.personId])))).toBe('42501');
    const tried = await as(priya, (tx) => tx.query('UPDATE app.channels SET team_id = $1 WHERE id = $2', [ENG, channel])).then((r) => r.rowCount, (e: { code?: string }) => e.code);
    expect([0, '42501']).toContain(tried);
    expect((await channelRow(channel)).team_id).toBe(MKT);
  });

  it('is idempotent: a second pass, for the person or for everybody, moves nothing', async () => {
    expect(await rehome(priya)).toEqual([]);
    expect(await rehome(null)).toEqual([]);
    expect((await channelRow(channel)).team_id).toBe(MKT);
  });
});

describe('a person who has no team left', () => {
  let channel = '';
  let root = '';

  it('keeps the channel and everything in it, unreadable to all, and cannot open it: a plain error, not a channel they cannot use', async () => {
    const made = await open(rafi);
    channel = made.channel_id;
    root = await say(channel, rafi.actorId, 'Question before I go');
    await say(channel, rafi.actorId, 'follow-up', root);
    await leave(rafi, ENG);
    expect(await rehome(rafi)).toEqual([]);
    expect(await rehome(null)).toEqual([]);
    const row = await channelRow(channel);
    expect(row.team_id).toBe(ENG);
    expect(row.members).toEqual([rafi.personId]);
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.messages WHERE channel_id = $1', [channel])).rows.length))).toBe(2);
    for (const p of [rafi, priya, nadia, omar]) expect((await sees(p, 'read')).includes(channel), p.key).toBe(false);
    expect(await code(open(rafi))).toBe('42501');
    expect(await messageOf(open(rafi))).toMatch(/join a team first/);
  });

  it('gets the conversation back, under the team they join next, in the same channel', async () => {
    await join(rafi, MKT);
    expect(await code(open(rafi))).toBe('23514');
    const moved = await rehome(rafi);
    expect(moved.map((m) => [m.moved_channel_id, m.from_team_id, m.to_team_id])).toEqual([[channel, ENG, MKT]]);
    expect(await open(rafi)).toEqual({ channel_id: channel, created: false });
    expect(await messagesOf(rafi, channel)).toHaveLength(2);
    await post(rafi, channel, 'back again', root);
  });
});

describe('what is not moved', () => {
  it('a conversation with a team bot stays in the bot’s team, and a person whose only other team is archived keeps the channel where it is', async () => {
    const helper = await open(nadia, teamBotId);
    const brain = await open(nadia);
    await join(nadia, MKT, 0);
    await sys((tx) => tx.query('UPDATE app.teams SET archived_at = now() WHERE id = $1', [MKT]));
    await leave(nadia, ENG);
    expect(await rehome(nadia)).toEqual([]);
    expect((await channelRow(helper.channel_id)).team_id).toBe(ENG);
    expect((await channelRow(brain.channel_id)).team_id).toBe(ENG);
    await sys((tx) => tx.query('UPDATE app.teams SET archived_at = NULL WHERE id = $1', [MKT]));
    // with the team back the sweep (everybody) moves the Brain conversation, and still not the team bot's
    const moved = await rehome(null);
    expect(moved.map((m) => m.moved_channel_id)).toEqual([brain.channel_id]);
    expect((await channelRow(helper.channel_id)).team_id).toBe(ENG);
    expect((await channelRow(brain.channel_id)).team_id).toBe(MKT);
  });
});
