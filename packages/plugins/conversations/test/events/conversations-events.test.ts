import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { ChannelChannelCreatedEvent, ConversationsConversationStartedEvent, eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../../channels/test/world.ts';

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

// Event contract tests (pnpm test:events): the event a new conversation announces is stored in the shape its registered schema accepts, with
// no text of the conversation and no team (a team-scoped event is readable by every member of the team, and a conversation is one person's),
// once per conversation however many messages follow; and the channel made for it is announced with the existing `channel.channel.created`
// as a private `bot_conversation`, also with no team, like a DM's.

let w: World;
let teamId = '';
let botId = '';
let channelId = '';
let rootId = '';

const eventRows = (type: string): Promise<EventRow[]> =>
  w.system(
    async (tx) =>
      (
        await tx.query<EventRow>(
          `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = $1 ORDER BY id`,
          [type],
        )
      ).rows,
  );

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

beforeAll(async () => {
  w = await createWorld();
  teamId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  botId = await w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers)
       VALUES ($1, $2, 'evbot', 'EvBot', '', 'agent', 'rules', 'team', repeat('e', 64), 'active', '[{"type":"conversation"}]'::jsonb) RETURNING id`,
      [omar.workspaceId, teamId],
    );
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, bot.rows[0]!.id]);
    return bot.rows[0]!.id;
  });
  const opened = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/evbot/conversation');
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  channelId = opened.body.channelId;
  const root = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'A private question about the migration', threadRootId: null });
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  rootId = root.body.id;
  // a follow-up reply and a second root: neither announces the first conversation again
  await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'And a follow-up', threadRootId: rootId });
  await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'A second question', threadRootId: null });
  await until(async () => ((await eventRows('conversations.conversation.started')).length >= 2 ? true : null), 'both conversations to be announced');
}, 240_000);

afterAll(async () => {
  await w?.close();
});

describe('conversations events', () => {
  it('registers the event at schema version 1 and the manifest lists it', async () => {
    expect(Object.keys(eventRegistry['conversations.conversation.started'])).toEqual(['1']);
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits].sort()).toEqual(['channel.channel.created', 'conversations.conversation.started']);
    expect([...plugin.manifest.events.consumes]).toEqual(['channel.message.posted']);
  });

  it('one started event per conversation, parsing against its schema, with the ids and no text and no team', async () => {
    const rows = await eventRows('conversations.conversation.started');
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => (r.payload as Record<string, unknown>)['threadRootId'] === rootId)!;
    const event = ConversationsConversationStartedEvent.parse(parseEvent(eventToRaw(first)));
    expect(event).toMatchObject({ botId, personId: nadia.personId, channelId, threadRootId: rootId });
    expect(event).not.toHaveProperty('teamId');
    for (const row of rows) {
      // the column `events_select` reads for team members: null, so only a workspace admin's policy reaches the row
      expect(row.team_id, 'team_id').toBeNull();
      expect(JSON.stringify(row.payload)).not.toMatch(/migration|follow-up|question/);
    }
  });

  it('the channel is announced as a private bot conversation, with no team on the event', async () => {
    const rows = (await eventRows('channel.channel.created')).filter((r) => (r.payload as Record<string, unknown>)['channelId'] === channelId);
    expect(rows).toHaveLength(1);
    const event = ChannelChannelCreatedEvent.parse(parseEvent(eventToRaw(rows[0]!)));
    expect(event).toMatchObject({ kind: 'bot_conversation', private: true, teamId: null, name: '' });
    expect(rows[0]!.team_id).toBeNull();
    expect(rows[0]!.actor_id).toBe(nadia.actorId);
  });
});
