import { randomUUID } from 'node:crypto';
import { CapabilityBroker, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from './world.ts';

// `messages.update`: a bot replaces the text of a message it posted itself (the Orchestrator's one live checklist). Through a real run and the
// capability broker: the grant decides, only the author may edit, the edit is audited and pushed like a person's, and it wakes nobody.

const { nadia } = personas;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let dev = '';
let appPool: ReturnType<typeof createAppPool>;
let systemPool: ReturnType<typeof createSystemPool>;
let runs: ReturnType<typeof createRunService>;
let handlers: Record<string, (input: Record<string, unknown>, tx: PluginTx) => unknown>;
let orch = { botId: '', actorId: '' };
let other = { botId: '', actorId: '' };

const makeBot = (slug: string, grants: string[]): Promise<{ botId: string; actorId: string }> =>
  w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [nadia.workspaceId, TEAM_IDS.Engineering, slug],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [nadia.workspaceId, bot.rows[0]!.id]);
    const actorId = actor.rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actorId, nadia.workspaceId]);
    for (const g of grants) {
      await tx.query("INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}')", [TEAM_IDS.Engineering, actorId, g]);
    }
    return { botId: bot.rows[0]!.id, actorId };
  });

const open = (b: { botId: string }): Promise<BotRunHandle> =>
  runs.open({ botId: b.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId }).then((r) => r.run);

/** Authorize like the gateway does, then run the registered handler as the bot. */
async function call(run: BotRunHandle, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const decision = await runs.authorize(run, name, {});
  if (!decision.allowed) throw Object.assign(new Error(decision.reason), { denied: true });
  return (await runs.asBot(run, async (tx) => await handlers[name]!(input, tx))) as Record<string, unknown>;
}

const row = (id: string) =>
  w.system(async (tx) => (await tx.query<{ body: string; edited_at: Date | null }>('SELECT body, edited_at FROM app.messages WHERE id = $1', [id])).rows[0]!);
const events = (type: string, messageId: string) =>
  w.system(async (tx) => (await tx.query("SELECT 1 FROM app.events WHERE type = $1 AND payload ->> 'messageId' = $2", [type, messageId])).rows.length);

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  const reg = w.server.host.registries.capabilityHandlers;
  handlers = {
    'messages.post': reg.get('messages.post')!.handler as never,
    'messages.update': reg.get('messages.update')!.handler as never,
  };
  orch = await makeBot('orch', ['messages.post', 'messages.update']);
  other = await makeBot('other', ['messages.post']);
  appPool = createAppPool(w.server.db.appUrl);
  systemPool = createSystemPool(w.server.db.systemUrl, 2);
  runs = createRunService({
    pool: appPool,
    systemPool,
    registry: w.server.host.capabilities,
    broker: new CapabilityBroker({ registry: w.server.host.capabilities, grants: createDbGrantSource({ pool: systemPool }) }),
    handlers: w.server.host.registries.capabilityHandlers,
  });
}, 180_000);


afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
  await w?.close();
});

describe('messages.update', () => {
  it('is a registered, non-destructive capability', () => {
    expect(w.server.host.capabilities.get('messages.update')).toMatchObject({ destructive: false, plugin: 'channels' });
  });

  it('replaces the body of the bot’s own message, marks it edited, audits and pushes it', async () => {
    const run = await open(orch);
    const posted = await call(run, 'messages.post', { channelId: dev, body: '- [ ] step one' });
    const id = posted['messageId'] as string;
    const done = await call(run, 'messages.update', { channelId: dev, messageId: id, body: '- [x] step one\n- [ ] step two' });
    expect(done).toMatchObject({ ok: true, messageId: id, channelId: dev });
    const r = await row(id);
    expect(r.body).toBe('- [x] step one\n- [ ] step two');
    expect(r.edited_at).not.toBeNull();
    expect(await events('channel.message.edited', id)).toBe(1);
    // a person reading the channel sees the new text
    const feed = await w.call<{ items: { id: string; body: string }[] }>(nadia, 'GET', `/api/channels/${dev}/messages?limit=50`);
    expect(feed.body.items.find((m) => m.id === id)?.body).toBe('- [x] step one\n- [ ] step two');
  });

  it('refuses another author’s message (a person’s or another bot’s), and an unknown one', async () => {
    const mine = await open(orch);
    const theirs = await open(other);
    const botMsg = (await call(mine, 'messages.post', { channelId: dev, body: 'mine' }))['messageId'] as string;
    await expect(call(theirs, 'messages.update', { channelId: dev, messageId: botMsg, body: 'hijack' })).rejects.toThrow();
    const person = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'from a person', threadRootId: null });
    await expect(call(mine, 'messages.update', { channelId: dev, messageId: person.body.id, body: 'hijack' })).rejects.toMatchObject({ status: 403 });
    await expect(call(mine, 'messages.update', { channelId: dev, messageId: randomUUID(), body: 'x' })).rejects.toMatchObject({ status: 404 });
    expect((await row(botMsg)).body).toBe('mine');
    expect((await row(person.body.id)).body).toBe('from a person');
  });

  it('is denied by the broker to a bot that was not granted it', async () => {
    const theirs = await open(other);
    const posted = (await call(theirs, 'messages.post', { channelId: dev, body: 'x' }))['messageId'] as string;
    await expect(call(theirs, 'messages.update', { channelId: dev, messageId: posted, body: 'y' })).rejects.toMatchObject({ denied: true });
  });

  it('keeps the post’s limits: empty and over-long text are refused', async () => {
    const run = await open(orch);
    const id = (await call(run, 'messages.post', { channelId: dev, body: 'limits' }))['messageId'] as string;
    await expect(call(run, 'messages.update', { channelId: dev, messageId: id, body: '' })).rejects.toThrow();
    await expect(call(run, 'messages.update', { channelId: dev, messageId: id, body: 'x'.repeat(40_001) })).rejects.toThrow();
    expect((await row(id)).body).toBe('limits');
  });

  it('never wakes anyone: a person named only in the edit gets no mention', async () => {
    const run = await open(orch);
    const id = (await call(run, 'messages.post', { channelId: dev, body: 'plain' }))['messageId'] as string;
    await call(run, 'messages.update', { channelId: dev, messageId: id, body: 'now with @nadia named' });
    const mentions = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_mentions WHERE message_id = $1', [id])).rows.length);
    expect(mentions).toBe(0);
    expect(await events('channel.mention.created', id)).toBe(0);
  });
});
