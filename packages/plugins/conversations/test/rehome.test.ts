import { createMemoryKv, createPluginContext, createSecretService, emit, eventToRaw, ExtensionRegistries, type EventRow, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { ConversationsConversationMovedEvent, ListMessagesResponse, OpenConversationResponse, eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';
import conversations from '../src/index.ts';
import { REHOME_SWEEP_QUEUE } from '../src/rehome.ts';

// P20-07: a person leaves the team their conversation with the workspace Brain was made in. The team event reaches the conversations plugin through the outbox, the system
// role moves the channel to their current team, and the move is announced once, with ids only. Through the real routes: they read and post again under the new team, and
// nobody else gains access.

const { nadia, tariq, priya } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: World;
let brainId = '';
let channelId = '';
let rootId = '';
let eng = '';
let mkt = '';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const teamOfChannel = (): Promise<string> => w.system(async (tx) => (await tx.query<{ team_id: string }>('SELECT team_id FROM app.channels WHERE id = $1', [channelId])).rows[0]!.team_id);
const movedEvents = (): Promise<EventRow[]> =>
  w.system(
    async (tx) =>
      (await tx.query<EventRow>(`SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = 'conversations.conversation.moved' ORDER BY id`)).rows,
  );
const messagesAs = (who: typeof priya) => w.call(who, 'GET', `/api/channels/${channelId}/messages`);

beforeAll(async () => {
  w = await createWorld();
  [eng, mkt] = await w.system(async (tx) => {
    const t = await tx.query<{ id: string; slug: string }>("SELECT id, slug FROM app.teams WHERE slug IN ('engineering', 'marketing') ORDER BY slug");
    return [t.rows.find((r) => r.slug === 'engineering')!.id, t.rows.find((r) => r.slug === 'marketing')!.id];
  });
  brainId = await w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, scope, triggers)
       VALUES ($1, NULL, 'atlas', 'Atlas', '', 'agent', 'rules', 'workspace', repeat('d', 64), 'active', 'workspace', '[{"type":"conversation"}]'::jsonb) RETURNING id`,
      [priya.workspaceId],
    );
    await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [priya.workspaceId, bot.rows[0]!.id]);
    // Priya joined Engineering first, so that is the team the conversation is made in
    await tx.query(`UPDATE app.team_members SET created_at = now() - interval '3 days' WHERE team_id = $1 AND actor_id = $2`, [eng, priya.actorId]);
    await tx.query(`UPDATE app.team_members SET created_at = now() - interval '1 day' WHERE team_id = $1 AND actor_id = $2`, [mkt, priya.actorId]);
    return bot.rows[0]!.id;
  });
  const opened = await w.call<unknown>(priya, 'POST', '/api/teams/engineering/bots/atlas/conversation');
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  channelId = OpenConversationResponse.parse(opened.body).channelId;
  const root = await w.call<{ id: string }>(priya, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'A private question about the roadmap', threadRootId: null });
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  rootId = root.body.id;
  expect(await teamOfChannel()).toBe(eng);
}, 240_000);

afterAll(async () => {
  await w?.close();
});

describe('the conversation follows the person (P20-07)', () => {
  it('declares the event and its two inputs, and the sweep job', () => {
    expect(Object.keys(eventRegistry['conversations.conversation.moved'])).toEqual(['1']);
    expect(conversations.manifest.events.emits).toContain('conversations.conversation.moved');
    expect(conversations.manifest.events.consumes).toEqual(expect.arrayContaining(['team.member.removed', 'team.member.added']));
  });

  it('moves to the oldest remaining team when the person leaves the first one; the history keeps its ids and they read and post again', async () => {
    const left = await w.call(priya, 'DELETE', `/api/teams/engineering/members/${priya.personId}`);
    expect(left.status, JSON.stringify(left.body)).toBeLessThan(300);
    expect(await until(async () => ((await teamOfChannel()) === mkt ? true : null), 'the conversation to move to Marketing')).toBe(true);
    const read = await messagesAs(priya);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(ListMessagesResponse.parse(read.body).items.map((m) => m.id)).toContain(rootId);
    const posted = await w.call(priya, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'Still here, in my new team', threadRootId: rootId });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    // the same door, through the team they are in now, finds the same channel
    const again = await w.call<unknown>(priya, 'POST', '/api/teams/marketing/bots/atlas/conversation');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(OpenConversationResponse.parse(again.body)).toMatchObject({ channelId, created: false });
  });

  it('announces the move once, ids only, with no team on the event', async () => {
    const rows = await until(async () => {
      const found = await movedEvents();
      return found.length > 0 ? found : null;
    }, 'the moved event');
    expect(rows).toHaveLength(1);
    const event = ConversationsConversationMovedEvent.parse(parseEvent(eventToRaw(rows[0]!)));
    expect(event).toMatchObject({ botId: brainId, personId: priya.personId, channelId, fromTeamId: eng, toTeamId: mkt });
    expect(event).not.toHaveProperty('teamId');
    expect(rows[0]!.team_id).toBeNull();
    expect(Object.keys(event).sort()).toEqual(['botId', 'channelId', 'fromTeamId', 'personId', 'schemaVersion', 'toTeamId', 'type', 'workspaceId']);
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/roadmap|new team/);
  });

  it('gives nobody else access: a member of the old team and the lead of the new one read nothing', async () => {
    for (const other of [nadia, tariq]) {
      const res = await messagesAs(other);
      expect(res.status, other.key).not.toBe(200);
    }
  });

  it('a person who leaves their last team keeps the channel and its history, unread by anyone', async () => {
    const left = await w.call(priya, 'DELETE', `/api/teams/marketing/members/${priya.personId}`);
    expect(left.status, JSON.stringify(left.body)).toBeLessThan(300);
    expect(await teamOfChannel()).toBe(mkt);
    const messages = await w.system(async (tx) => (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.messages WHERE channel_id = $1', [channelId])).rows[0]!.n);
    expect(Number(messages)).toBeGreaterThanOrEqual(2);
    // she is in no team: she reads nothing of it, and no one else does either (the database door's own words are checked in test/rls/rehome.test.ts)
    expect((await messagesAs(priya)).status).not.toBe(200);
    expect((await movedEvents()).length).toBe(1);
  });

  it('the ten-minute sweep is the net for a notice that never came: a team seat written without an event still brings the conversation home, once', async () => {
    const registries = new ExtensionRegistries();
    const ctx = createPluginContext(conversations.manifest, {
      registries,
      storage: createMemoryKv(),
      mail: { configured: true, send: () => Promise.resolve() },
      runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
      secrets: createSecretService(),
      emit: (tx, event) => emit(tx as unknown as Tx, event),
    });
    await conversations.register(ctx);
    const job = registries.jobs.list().find((j) => j.value.queue === REHOME_SWEEP_QUEUE);
    expect(job?.value.options.cron).toBe('*/10 * * * *');
    // she is back on Engineering by a direct write: no team.member.added was emitted for it
    await w.system((tx) => tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [eng, priya.actorId, priya.workspaceId]));
    const before = (await movedEvents()).length;
    const run = (): Promise<unknown> => w.system((tx) => Promise.resolve(job!.value.handler({}, tx as unknown as PluginTx, undefined as never)));
    await run();
    expect(await teamOfChannel()).toBe(eng);
    expect((await movedEvents()).length).toBe(before + 1);
    await run();
    expect((await movedEvents()).length).toBe(before + 1);
  });
});
