import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A bot's name on a message it wrote. channels 0005 named every bot "Bot" with a comment that the bots plugin would give bots a name of
// their own later; bots 0013 does it. The name is the bot row's own, so the roster, the bot page and the message list cannot disagree.

const { omar, nadia, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const sha = (n: number): string => n.toString(16).padStart(64, '0');

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const authors = (p: Persona, ids: string[]): Promise<Array<{ actor_id: string; display_name: string; kind: string }>> =>
  as(p, async (tx) => (await tx.query<{ actor_id: string; display_name: string; kind: string }>('SELECT actor_id, display_name, kind FROM app.message_authors($1::uuid[])', [ids])).rows);

let botActorId = '';
let botMessageId = '';
let ghostActorId = '';
let ghostMessageId = '';

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);

  await sys(async (tx) => {
    const channel = await tx.query<{ id: string }>(
      `INSERT INTO app.channels (workspace_id, team_id, name, kind) VALUES ($1, $2, 'bot-names', 'channel') RETURNING id`,
      [omar.workspaceId, ENG],
    );
    const channelId = channel.rows[0]!.id;

    // a bot with a name of its own, seated on the team, as the loader leaves it
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
       VALUES ($1, $2, 'coder', 'Coder', 'Writes and reviews code', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}') RETURNING id`,
      [omar.workspaceId, ENG, sha(5)],
    );
    const botId = bot.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(
      `INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`,
      [omar.workspaceId, botId],
    );
    botActorId = actor.rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (workspace_id, team_id, actor_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`, [
      omar.workspaceId,
      ENG,
      botActorId,
    ]);
    botMessageId = (
      await tx.query<{ id: string }>(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'Reviewed the change', 'Reviewed the change') RETURNING id`, [omar.workspaceId, channelId, botActorId])
    ).rows[0]!.id;

    // a bot actor whose bot row is gone: what a removed bot leaves behind, and the label it falls back to
    const ghost = await tx.query<{ id: string }>(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`, [
      omar.workspaceId,
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
           VALUES ($1, $2, 'retired', 'Retired', 'Gone', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}') RETURNING id`,
          [omar.workspaceId, ENG, sha(7)],
        )
      ).rows[0]!.id,
    ]);
    ghostActorId = ghost.rows[0]!.id;
    await tx.query(`UPDATE app.bots SET status = 'disabled' WHERE slug = 'retired'`);
    ghostMessageId = (
      await tx.query<{ id: string }>(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'Still here', 'Still here') RETURNING id`, [omar.workspaceId, channelId, ghostActorId])
    ).rows[0]!.id;
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('a bot is named by its own row on a message (bots 0013)', () => {
  it('names the bot, not "Bot", for every reader of the message', async () => {
    for (const reader of [omar, nadia]) {
      expect((await authors(reader, [botMessageId])).map((r) => [r.display_name, r.kind]), `${reader.name} reads the bot's name`).toEqual([
        ['Coder', 'bot'],
      ]);
    }
    expect((await authors(omar, [botMessageId]))[0]?.actor_id).toBe(botActorId);
  });

  it('names nobody to a reader who cannot see the message (the channel gate is unchanged)', async () => {
    expect(await authors(lena, [botMessageId])).toEqual([]);
  });

  it('falls back to the old label for a bot whose row is not there to name it by', async () => {
    // the message stays; the name does not. Nothing invents a name for a bot the caller cannot look up.
    expect((await authors(omar, [ghostMessageId])).map((r) => [r.display_name, r.kind])).toEqual([['Retired', 'bot']]);
  });
});
