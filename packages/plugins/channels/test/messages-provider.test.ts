import { randomUUID } from 'node:crypto';
import { withActor, type Actor } from '@manythreads/kernel';
import type { MessagePostInput, MessageProvider, PluginTx } from '@manythreads/sdk';
import { AnswerPayload } from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from './world.ts';

// The `messages` provider (PLAN P5-18): how a plugin posts a message with a `meta`. It takes no caller's word for what the meta says — the run
// is the transaction's own, the bot is the one that posts, and the text of an Answer is the text of the message.

const { nadia } = personas;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let provider: MessageProvider;
let dev = '';
let brain = { id: '', actor: '' };
let coder = { id: '', actor: '' };
let brainRun = '';
let otherRun = '';

const makeBot = (slug: string): Promise<{ id: string; actor: string }> =>
  w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [nadia.workspaceId, TEAM_IDS.Engineering, slug],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [nadia.workspaceId, bot.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, nadia.workspaceId]);
    return { id: bot.rows[0]!.id, actor: actor.rows[0]!.id };
  });

const makeRun = (botId: string): Promise<string> =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status)
           VALUES ($1, $2, $3, 'mention', $4, $5, 'running') RETURNING id`,
          [nadia.workspaceId, botId, TEAM_IDS.Engineering, nadia.actorId, dev],
        )
      ).rows[0]!.id,
  );

const post = (actor: Actor, input: Omit<MessagePostInput, 'channelId'>) =>
  withActor(actor, (tx) => provider.post(tx as unknown as PluginTx, { channelId: dev, ...input }), { pool: w.server.pools.app });

const bot = (b: { actor: string }, runId?: string): Actor => ({ kind: 'bot', id: b.actor, workspaceId: nadia.workspaceId, ...(runId ? { runId } : {}) }) as unknown as Actor;

const answer = (over: { body?: string; botId?: string; runId?: string } = {}): AnswerPayload =>
  AnswerPayload.parse({
    version: 1,
    body: over.body ?? 'The answer',
    citations: [],
    lineage: [],
    sourcesReached: [],
    outsideScope: { count: 0, items: [] },
    answeredFor: { personId: null, name: null, scope: 'team', alias: null, botId: over.botId ?? brain.id, runId: over.runId ?? brainRun },
    chips: [],
  });

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  const found = w.server.host.registries.providers.messages.values()[0];
  if (!found) throw new Error('the channels plugin did not register the messages provider');
  provider = found as MessageProvider;
  brain = await makeBot('brain');
  coder = await makeBot('coder');
  brainRun = await makeRun(brain.id);
  otherRun = await makeRun(coder.id);
});

afterAll(async () => {
  await w?.close();
});

describe('the meta a plugin may put on a message', () => {
  it('stores an answer of the transaction’s own run, by the bot that posts it, with the message’s own text', async () => {
    const posted = await post(bot(brain, brainRun), { body: 'The answer', meta: { answer: answer(), runId: brainRun } });
    const row = await w.system(async (tx) => (await tx.query<{ meta: { runId?: string; answer?: { body?: string } }; body: string }>('SELECT meta, body FROM app.messages WHERE id = $1', [posted.id])).rows[0]!);
    expect(row.body).toBe('The answer');
    expect(row.meta.runId).toBe(brainRun);
    expect(row.meta.answer?.body).toBe('The answer');
  });

  it('refuses a run id that is not the run the transaction acts for: another run, or no run at all', async () => {
    await expect(post(bot(brain, brainRun), { body: 'x', meta: { runId: otherRun } })).rejects.toMatchObject({ status: 403 });
    await expect(post(bot(brain, brainRun), { body: 'x', meta: { runId: randomUUID() } })).rejects.toMatchObject({ status: 403 });
    await expect(post(bot(brain), { body: 'x', meta: { runId: brainRun } })).rejects.toMatchObject({ status: 403 });
    // and a person, who has no run, cannot name one
    await expect(post({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId } as Actor, { body: 'x', meta: { runId: brainRun } })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an answer that names another run or another bot as the one it was written for', async () => {
    await expect(post(bot(brain, brainRun), { body: 'The answer', meta: { answer: answer({ runId: otherRun }), runId: brainRun } })).rejects.toMatchObject({ status: 403 });
    await expect(post(bot(brain, brainRun), { body: 'The answer', meta: { answer: answer({ botId: coder.id }), runId: brainRun } })).rejects.toMatchObject({ status: 403 });
    // a person cannot post an answer as the bot's, with the bot's run id, either
    await expect(
      post({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId } as Actor, { body: 'The answer', meta: { answer: answer(), runId: brainRun } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an answer whose text is not the message’s text, and one that does not say which run wrote it', async () => {
    await expect(post(bot(brain, brainRun), { body: 'What the message says', meta: { answer: answer({ body: 'What the Answer says' }), runId: brainRun } })).rejects.toMatchObject({ status: 400 });
    await expect(post(bot(brain, brainRun), { body: 'The answer', meta: { answer: answer() } })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a key it does not know, and a payload that is not an Answer', async () => {
    await expect(post(bot(brain, brainRun), { body: 'x', meta: { verified: true } as never })).rejects.toMatchObject({ status: 400 });
    await expect(post(bot(brain, brainRun), { body: 'x', meta: { answer: { version: 1 }, runId: brainRun } })).rejects.toMatchObject({ status: 400 });
  });

  it('is still the one write: a message with no meta is an ordinary message', async () => {
    const posted = await post(bot(brain, brainRun), { body: 'A plain reply' });
    expect(posted.channelId).toBe(dev);
    const meta = await w.system(async (tx) => (await tx.query<{ meta: Record<string, unknown> }>('SELECT meta FROM app.messages WHERE id = $1', [posted.id])).rows[0]!.meta);
    expect(meta).toEqual({});
  });
});
