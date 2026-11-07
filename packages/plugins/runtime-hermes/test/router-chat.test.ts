import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerChatRouter } from '../src/router-chat.ts';
import { RUN_QUEUE } from '../src/run-job.ts';

// Regenerate in the Chat screen, the router's side (PLAN P20-16, P20-T4): the announcement of "another answer" starts one more run for the person's own message, as
// the first run was started, and only when every fact it names still holds. The database is a canned one: each query answers by the table it reads.

const WS = '00000000-0000-7000-8000-00000000a001';
const BOT = '00000000-0000-7000-8000-000000000001';
const TEAM = '00000000-0000-7000-8000-0000000b0001';
const PERSON = '00000000-0000-7000-8000-0000000e0001';
const CHANNEL = '00000000-0000-7000-8000-000000000002';
const ROOT = '00000000-0000-7000-8000-000000000003';
const TURN = '00000000-0000-7000-8000-000000000004';
const AUTHOR = '00000000-0000-7000-8000-0000000d0001';

const event = (over: Record<string, unknown> = {}): PluginEvent =>
  ({ type: 'conversations.turn.regenerated', schemaVersion: 1, workspaceId: WS, botId: BOT, personId: PERSON, channelId: CHANNEL, threadRootId: ROOT, turnMessageId: TURN, modelAlias: null, ...over }) as unknown as PluginEvent;

interface World {
  message: Record<string, unknown> | undefined;
  authorRef: string | undefined;
  bot: { id: string; slug: string; triggers: unknown[] | null } | undefined;
}

const fresh = (over: Partial<World> = {}): World => ({
  message: {
    id: TURN,
    body: 'What is blocking the release?',
    channel_id: CHANNEL,
    thread_root_id: ROOT,
    author_id: AUTHOR,
    channel_name: 'brain-nadia',
    channel_team: TEAM,
    channel_private: true,
    channel_archived: null,
    channel_bot_id: BOT,
    channel_kind: 'bot_conversation',
    author_kind: 'person',
    author_name: 'Nadia',
    carries_answer: false,
    is_handoff_card: false,
    is_channel_copy: false,
    is_poll: false,
  },
  authorRef: PERSON,
  bot: { id: BOT, slug: 'brain', triggers: [{ type: 'conversation' }] },
  ...over,
});

function rig(world: World): { handler: (e: PluginEvent, tx: PluginTx, meta?: { eventId?: string }) => Promise<void>; jobs: Array<{ queue: string; payload: Record<string, unknown>; opts: Record<string, unknown> }>; tx: PluginTx } {
  const jobs: Array<{ queue: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  let handler: ((e: PluginEvent, tx: PluginTx, meta?: { eventId?: string }) => Promise<void>) | null = null;
  const ctx = {
    events: { subscribe: (type: string, fn: typeof handler) => { expect(type).toBe('conversations.turn.regenerated'); handler = fn; } },
    jobs: { enqueue: async (_tx: unknown, queue: string, payload: Record<string, unknown>, opts: Record<string, unknown>): Promise<void> => { jobs.push({ queue, payload, opts }); } },
  } as unknown as PluginContext;
  const tx = {
    query: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM app.messages m')) return { rows: world.message ? [world.message] : [] };
      if (sql.includes('FROM app.actors')) return { rows: world.authorRef ? [{ ref_id: world.authorRef }] : [] };
      if (sql.includes('FROM app.bots')) return { rows: world.bot ? [world.bot] : [] };
      if (sql.includes('FROM app.projects')) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  } as unknown as PluginTx;
  registerChatRouter(ctx);
  return { handler: handler as never, jobs, tx };
}

describe('registerChatRouter', () => {
  it('starts one run for the message, as its first run was started, with the same asker and thread', async () => {
    const r = rig(fresh());
    await r.handler(event(), r.tx, { eventId: 'evt-1' });
    expect(r.jobs).toHaveLength(1);
    const job = r.jobs[0]!;
    expect(job.queue).toBe(RUN_QUEUE);
    expect(job.payload).toMatchObject({
      workspaceId: WS,
      botId: BOT,
      teamId: TEAM,
      channelId: CHANNEL,
      trigger: 'conversation',
      askerActorId: AUTHOR,
      replyRootId: ROOT,
      runThreadId: ROOT,
      messageId: TURN,
      text: 'What is blocking the release?',
    });
    expect(String(job.payload['prompt'])).toContain('What is blocking the release?');
    expect(job.payload).not.toHaveProperty('modelAlias');
    // one run per announcement: the key names the bot, the message and the event, so a redelivery finds the job already there
    expect(job.opts).toEqual({ dedupeKey: `runtime-hermes:regenerate:${BOT}:${TURN}:evt-1` });
  });

  it('passes the picked model on, and falls back to the message id for the key when the event has no id of its own', async () => {
    const r = rig(fresh());
    await r.handler(event({ modelAlias: 'fast' }), r.tx);
    expect(r.jobs[0]?.payload['modelAlias']).toBe('fast');
    expect(r.jobs[0]?.opts).toEqual({ dedupeKey: `runtime-hermes:regenerate:${BOT}:${TURN}:${TURN}` });
  });

  it('uses the message itself as the reply root when it is the root of the thread', async () => {
    const r = rig(fresh({ message: { ...fresh().message!, thread_root_id: null, id: TURN } }));
    await r.handler(event(), r.tx);
    expect(r.jobs[0]?.payload).toMatchObject({ replyRootId: TURN, runThreadId: null });
  });

  const refused: Array<[string, Partial<World> | (() => Partial<World>)]> = [
    ['the message is gone', { message: undefined }],
    ['the message is a bot’s, not the person’s', () => ({ message: { ...fresh().message!, author_kind: 'bot' } })],
    ['the channel is not a conversation channel', () => ({ message: { ...fresh().message!, channel_kind: 'public' } })],
    ['the message is in another channel than the announcement names', () => ({ message: { ...fresh().message!, channel_id: '00000000-0000-7000-8000-0000000000ff' } })],
    ['the channel belongs to another bot', () => ({ message: { ...fresh().message!, channel_bot_id: '00000000-0000-7000-8000-0000000000fe' } })],
    ['the channel has no team', () => ({ message: { ...fresh().message!, channel_team: null } })],
    ['the channel is archived', () => ({ message: { ...fresh().message!, channel_archived: new Date() } })],
    ['the message was written by somebody else than the person who asked', { authorRef: '00000000-0000-7000-8000-0000000000fd' }],
    ['the bot is not active any more', { bot: undefined }],
    ['the bot no longer answers a conversation', { bot: { id: BOT, slug: 'brain', triggers: [{ type: 'mention' }] } }],
    ['the bot has no triggers', { bot: { id: BOT, slug: 'brain', triggers: null } }],
  ];
  for (const [name, over] of refused) {
    it(`starts nothing when ${name}`, async () => {
      const r = rig(fresh(typeof over === 'function' ? over() : over));
      await r.handler(event(), r.tx, { eventId: 'evt-2' });
      expect(r.jobs).toHaveLength(0);
    });
  }
});
