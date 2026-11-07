import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
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

// P20-16: what the Chat screen adds to the conversation index: a title, a pin, a soft delete with a 30 second way back, the answers of a turn kept as
// variants, a person's thumbs, and the model a person picked for a message. Rows exist through the system role; every assertion runs as a persona.

const { omar, nadia, rafi } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let botId = '';
let botActorId = '';
let channel = '';
let root = '';
let turn2 = '';
let reply1 = '';
let reply2 = '';

const say = (author: string, text: string, rootId: string | null = null, meta: Record<string, unknown> = {}): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id, meta) VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb) RETURNING id`,
          [omar.workspaceId, channel, author, text, rootId, JSON.stringify(meta)],
        )
      ).rows[0]!.id,
  );

const variant = (reply: string, turn: string, no: number, chosen: boolean): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.conversation_variants (reply_message_id, turn_message_id, thread_root_id, workspace_id, person_id, variant_no, chosen) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [reply, turn, root, omar.workspaceId, nadia.personId, no, chosen],
    ),
  );

const row = (): Promise<{ title: string | null; title_source: string | null; pinned_at: Date | null; deleted_at: Date | null; model_alias: string | null }> =>
  as(nadia, async (tx) => (await tx.query<{ title: string | null; title_source: string | null; pinned_at: Date | null; deleted_at: Date | null; model_alias: string | null }>('SELECT title, title_source, pinned_at, deleted_at, model_alias FROM app.conversations WHERE thread_root_id = $1', [root])).rows[0]!);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, repoGitMigrationSource, botsMigrationSource, conversationsMigrationSource, answerMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'brain', 'Brain', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    botId = bot.rows[0]!.id;
    botActorId = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId])).rows[0]!.id;
  });
  channel = await as(nadia, async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.conversations_open($1::uuid)', [botId])).rows[0]!.channel_id);
  root = await say(nadia.actorId, 'What changed in the release?');
  await sys((tx) =>
    tx.query('INSERT INTO app.conversations (thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id) VALUES ($1, $2, $3, $4, $5, $6)', [root, omar.workspaceId, ENG, botId, nadia.personId, channel]),
  );
  reply1 = await say(botActorId, 'Three things changed.', root, { runId: randomUUID() });
  turn2 = await say(nadia.actorId, 'And the week before?', root);
  reply2 = await say(botActorId, 'Two things.', root, { runId: randomUUID() });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the Chat tables', () => {
  it('pass the RLS harness and read without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['conversations', 'conversation_variants', 'conversation_feedback', 'message_model_picks']) {
        expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
      }
    } finally {
      await admin.end();
    }
  });
});

describe('a conversation the person names, pins and deletes', () => {
  it('lets the person set the five columns of their own row, and a title only together with its source', async () => {
    await as(nadia, (tx) => tx.query(`UPDATE app.conversations SET title = 'Release notes', title_source = 'manual', pinned_at = now(), model_alias = 'fast' WHERE thread_root_id = $1`, [root]));
    expect(await row()).toMatchObject({ title: 'Release notes', title_source: 'manual', model_alias: 'fast' });
    expect((await row()).pinned_at).not.toBeNull();
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.conversations SET title = NULL WHERE thread_root_id = $1`, [root])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.conversations SET title = '', title_source = 'manual' WHERE thread_root_id = $1`, [root])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.conversations SET title = repeat('x', 81), title_source = 'manual' WHERE thread_root_id = $1`, [root])))).toBe('23514');
    await as(nadia, (tx) => tx.query('UPDATE app.conversations SET title = NULL, title_source = NULL, pinned_at = NULL, model_alias = NULL WHERE thread_root_id = $1', [root]));
    expect(await row()).toMatchObject({ title: null, title_source: null, pinned_at: null, model_alias: null });
  });

  it('keeps every other column, and every other person’s row, out of reach', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.conversations SET visibility = 'shared' WHERE thread_root_id = $1`, [root])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.conversations SET person_id = $2 WHERE thread_root_id = $1', [root, rafi.personId])))).toBe('42501');
    // Rafi neither sees nor changes Nadia's private row: the update touches nothing
    const touched = await as(rafi, async (tx) => (await tx.query(`UPDATE app.conversations SET title = 'Mine now', title_source = 'manual' WHERE thread_root_id = $1`, [root])).rowCount);
    expect(touched).toBe(0);
    expect((await row()).title).toBeNull();
  });

  it('deletes softly, restores within 30 seconds, and refuses a restore after that', async () => {
    await as(nadia, (tx) => tx.query('UPDATE app.conversations SET deleted_at = now() WHERE thread_root_id = $1', [root]));
    expect((await row()).deleted_at).not.toBeNull();
    await as(nadia, (tx) => tx.query('UPDATE app.conversations SET deleted_at = NULL WHERE thread_root_id = $1', [root]));
    expect((await row()).deleted_at).toBeNull();
    // 31 seconds ago, written by the system role (retention's view of time)
    await sys((tx) => tx.query(`UPDATE app.conversations SET deleted_at = now() - interval '31 seconds' WHERE thread_root_id = $1`, [root]));
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.conversations SET deleted_at = NULL WHERE thread_root_id = $1', [root])))).toBe('23514');
    // and the person cannot push the time forward to reopen the window
    await as(nadia, (tx) => tx.query('UPDATE app.conversations SET deleted_at = now() WHERE thread_root_id = $1', [root]));
    expect((await row()).deleted_at!.getTime()).toBeLessThan(Date.now() - 25_000);
    await sys((tx) => tx.query('UPDATE app.conversations SET deleted_at = NULL WHERE thread_root_id = $1', [root]));
  });
});

describe('the answers of a turn', () => {
  it('are written by the system role and read by their asker alone', async () => {
    await variant(reply1, root, 1, true);
    await variant(reply2, turn2, 1, true);
    const mine = await as(nadia, async (tx) => (await tx.query<{ reply_message_id: string }>('SELECT reply_message_id FROM app.conversation_variants ORDER BY created_at')).rows.map((r) => r.reply_message_id));
    expect(mine).toEqual([reply1, reply2]);
    expect(await as(rafi, async (tx) => (await tx.query('SELECT 1 FROM app.conversation_variants')).rows.length)).toBe(0);
    expect(await as(omar, async (tx) => (await tx.query('SELECT 1 FROM app.conversation_variants')).rows.length)).toBe(0);
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.conversation_variants SET chosen = false WHERE turn_message_id = $1`, [root])))).toBe('42501');
  });

  it('number the variants of one turn once each', async () => {
    expect(await code(variant(reply2, root, 1, false))).toBe('23505');
  });

  it('switch the chosen one through the definer function, for the asker only', async () => {
    const second = await say(botActorId, 'Another try.', root, { runId: randomUUID() });
    await sys((tx) => tx.query(`UPDATE app.conversation_variants SET chosen = false WHERE turn_message_id = $1`, [root]));
    await variant(second, root, 2, true);
    const chosen = () =>
      as(nadia, async (tx) => (await tx.query<{ reply_message_id: string }>('SELECT reply_message_id FROM app.conversation_variants WHERE turn_message_id = $1 AND chosen', [root])).rows.map((r) => r.reply_message_id));
    expect(await chosen()).toEqual([second]);
    expect(await as(nadia, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.conversations_choose_variant($1::uuid, $2::uuid) AS ok', [root, reply1])).rows[0]!.ok)).toBe(true);
    expect(await chosen()).toEqual([reply1]);
    // somebody else's turn, and an answer that is not of that turn, change nothing
    expect(await as(rafi, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.conversations_choose_variant($1::uuid, $2::uuid) AS ok', [root, second])).rows[0]!.ok)).toBe(false);
    expect(await as(nadia, async (tx) => (await tx.query<{ ok: boolean }>('SELECT app.conversations_choose_variant($1::uuid, $2::uuid) AS ok', [root, reply2])).rows[0]!.ok)).toBe(false);
    expect(await chosen()).toEqual([reply1]);
  });
});

describe('a person’s thumbs', () => {
  it('are the person’s own, to write, change and take back', async () => {
    await as(nadia, (tx) => tx.query(`INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote, reason) VALUES ($1, $2, $3, 'up', 'clear')`, [reply1, nadia.personId, omar.workspaceId]));
    await as(nadia, (tx) => tx.query(`UPDATE app.conversation_feedback SET vote = 'down', reason = 'too long' WHERE message_id = $1`, [reply1]));
    expect(await as(nadia, async (tx) => (await tx.query('SELECT vote, reason FROM app.conversation_feedback')).rows)).toEqual([{ vote: 'down', reason: 'too long' }]);
    await as(nadia, (tx) => tx.query('DELETE FROM app.conversation_feedback WHERE message_id = $1', [reply1]));
    expect(await as(nadia, async (tx) => (await tx.query('SELECT 1 FROM app.conversation_feedback')).rows.length)).toBe(0);
  });

  it('are read by nobody else, a workspace admin included, and cannot be written for another conversation or person', async () => {
    await as(nadia, (tx) => tx.query(`INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote) VALUES ($1, $2, $3, 'up')`, [reply2, nadia.personId, omar.workspaceId]));
    expect(await as(omar, async (tx) => (await tx.query('SELECT 1 FROM app.conversation_feedback')).rows.length)).toBe(0);
    expect(await as(rafi, async (tx) => (await tx.query('SELECT 1 FROM app.conversation_feedback')).rows.length)).toBe(0);
    // Rafi rates an answer of Nadia's conversation, and Nadia writes a row in Rafi's name
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote) VALUES ($1, $2, $3, 'down')`, [reply1, rafi.personId, omar.workspaceId])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote) VALUES ($1, $2, $3, 'down')`, [reply1, rafi.personId, omar.workspaceId])))).toBe('42501');
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.conversation_feedback')).rows.length)).toBe(1);
  });

  it('take a vote of up or down and a reason of at most 140 characters', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote) VALUES ($1, $2, $3, 'meh')`, [reply1, nadia.personId, omar.workspaceId])))).toBe('23514');
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.conversation_feedback (message_id, person_id, workspace_id, vote, reason) VALUES ($1, $2, $3, 'up', repeat('x', 141))`, [reply1, nadia.personId, omar.workspaceId])))).toBe('23514');
  });
});

describe('the model a person picked for a message', () => {
  it('is filed and read by the asker, and by nobody else but the system role', async () => {
    await as(nadia, (tx) =>
      tx.query(`INSERT INTO app.message_model_picks (message_id, workspace_id, team_id, bot_id, asked_by, model_alias) VALUES ($1, $2, $3, $4, $5, 'smart')`, [turn2, omar.workspaceId, ENG, botId, nadia.actorId]),
    );
    expect(await as(nadia, async (tx) => (await tx.query('SELECT model_alias FROM app.message_model_picks')).rows)).toEqual([{ model_alias: 'smart' }]);
    expect(await as(rafi, async (tx) => (await tx.query('SELECT 1 FROM app.message_model_picks')).rows.length)).toBe(0);
    expect(await as(omar, async (tx) => (await tx.query('SELECT 1 FROM app.message_model_picks')).rows.length)).toBe(0);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.message_model_picks')).rows.length)).toBe(1);
  });

  it('can only be filed for the asker’s own message, and never changed afterwards', async () => {
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.message_model_picks (message_id, workspace_id, team_id, bot_id, asked_by, model_alias) VALUES ($1, $2, $3, $4, $5, 'fast')`, [reply1, omar.workspaceId, ENG, botId, rafi.actorId])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.message_model_picks SET model_alias = 'fast'`)))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.message_model_picks (message_id, workspace_id, team_id, bot_id, asked_by, model_alias) VALUES ($1, $2, $3, $4, $5, '')`, [root, omar.workspaceId, ENG, botId, nadia.actorId])))).toBe('23514');
  });
});
