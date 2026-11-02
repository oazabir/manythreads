import { CapabilityBroker, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from './world.ts';

// `messages.post` names the run that wrote a post (`meta.runId`) only where the run has a place to answer: a thread it was asked in, or the top of its channel for an `inbox` run
// (the connections plugin links a mail to the bot's post that way). A run of any other kind that has a channel but no thread (a routine, a rhythm, a task) must NOT be stamped:
// the runtime reads `meta.runId` as "this run already answered" and would skip its final reply (security review of P8-29/P8-30).

const { nadia } = personas;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let dev = '';
let appPool: ReturnType<typeof createAppPool>;
let systemPool: ReturnType<typeof createSystemPool>;
let runs: ReturnType<typeof createRunService>;
let post: (input: Record<string, unknown>, tx: PluginTx) => unknown;
let bot = { botId: '', actorId: '' };

const open = (trigger: string, where: { channelId?: string | null; replyRootId?: string | null }): Promise<BotRunHandle> =>
  runs.open({ botId: bot.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger, ...(trigger === 'mention' ? { askerActorId: nadia.actorId } : {}), ...where }).then((r) => r.run);

const posted = async (run: BotRunHandle, input: Record<string, unknown>): Promise<{ id: string; meta: Record<string, unknown> | null; thread: string | null }> => {
  const answer = (await runs.asBot(run, async (tx) => await post(input, tx))) as { messageId: string };
  const row = (await w.system(async (tx) => await tx.query<{ meta: Record<string, unknown> | null; thread_root_id: string | null }>('SELECT meta, thread_root_id FROM app.messages WHERE id = $1', [answer.messageId]))).rows[0]!;
  return { id: answer.messageId, meta: row.meta, thread: row.thread_root_id };
};

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  post = w.server.host.registries.capabilityHandlers.get('messages.post')!.handler as never;
  bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, 'stamper', 'stamper', '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [nadia.workspaceId, TEAM_IDS.Engineering],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [nadia.workspaceId, row.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, nadia.workspaceId]);
    await tx.query("INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'messages.post', false, '{}')", [TEAM_IDS.Engineering, actor.rows[0]!.id]);
    return { botId: row.rows[0]!.id, actorId: actor.rows[0]!.id };
  });
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

describe('which top-level posts name their run', () => {
  it('an inbox run’s top-level post does (that is how its mail is linked to it)', async () => {
    const run = await open('inbox', { channelId: dev });
    const m = await posted(run, { channelId: dev, body: 'Mail seen' });
    expect(m.thread).toBeNull();
    expect(m.meta).toMatchObject({ runId: run.runId });
  });

  it.each(['routine', 'task_assigned', 'channel_message'])('a %s run with a channel but no thread does not: the runtime would take its post for the run’s answer', async (trigger) => {
    const run = await open(trigger, { channelId: dev });
    const m = await posted(run, { channelId: dev, body: `Top-level post of a ${trigger} run` });
    expect(m.thread).toBeNull();
    expect(m.meta === null || !('runId' in m.meta)).toBe(true);
  });

  it('a routine run does not get its channel as a default either: it has to name one', async () => {
    const run = await open('routine', { channelId: dev });
    await expect(posted(run, { body: 'no channel named' })).rejects.toMatchObject({ status: 400 });
  });

  it('a run asked in a thread still names itself, and its post lands in that thread', async () => {
    const root = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'a thread to answer in', threadRootId: null });
    const run = await open('mention', { channelId: dev, replyRootId: root.body.id });
    const m = await posted(run, { body: 'In the thread' });
    expect(m.thread).toBe(root.body.id);
    expect(m.meta).toMatchObject({ runId: run.runId });
  });
});
