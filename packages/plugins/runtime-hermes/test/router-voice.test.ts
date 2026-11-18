import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerRouter } from '../src/router-subscribe.ts';
import { RUN_QUEUE, RunPayload } from '../src/run-job.ts';

// A voice message is answered once, on the words (P32-04): `channel.message.posted` leaves a voice message that the server is transcribing (or has
// transcribed, or failed to) to `channel.message.transcribed`, which routes it with the text it has then. The database is a canned one: each query answers by
// the table it reads.

const WS = '00000000-0000-7000-8000-00000000a001';
const TEAM = '00000000-0000-7000-8000-0000000b0001';
const CHANNEL = '00000000-0000-7000-8000-000000000002';
const MSG = '00000000-0000-7000-8000-000000000050';
const BOT = '00000000-0000-7000-8000-000000000001';
const PERSON = '00000000-0000-7000-8000-000000000060';

const posted = (): PluginEvent => ({ type: 'channel.message.posted', schemaVersion: 1, workspaceId: WS, channelId: CHANNEL, teamId: TEAM, messageId: MSG, authorId: PERSON, threadRootId: null }) as unknown as PluginEvent;
const transcribed = (state: string): PluginEvent =>
  ({ type: 'channel.message.transcribed', schemaVersion: 1, workspaceId: WS, channelId: CHANNEL, teamId: TEAM, messageId: MSG, authorId: PERSON, threadRootId: null, state, transcriptEndMs: null }) as unknown as PluginEvent;

interface World {
  body: string;
  voice: string | null;
  announced: boolean;
}
function rig(world: World) {
  const jobs: Array<{ queue: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const handlers = new Map<string, (e: PluginEvent, tx: PluginTx) => Promise<void>>();
  const ctx = {
    events: { subscribe: (type: string, fn: (e: PluginEvent, tx: PluginTx) => Promise<void>) => void handlers.set(type, fn) },
    jobs: { enqueue: async (_tx: unknown, queue: string, payload: Record<string, unknown>, opts: Record<string, unknown>): Promise<void> => void jobs.push({ queue, payload, opts }) },
    audit: { emit: async (): Promise<void> => undefined },
    runtime: { now: () => new Date('2026-11-18T08:00:00.000Z') },
    http: { route: () => undefined },
    providers: { get: () => undefined },
  } as unknown as PluginContext;
  const tx = {
    query: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM app.messages m')) {
        return {
          rows: [
            {
              id: MSG, body: world.body, channel_id: CHANNEL, thread_root_id: null, author_id: PERSON, channel_name: 'dev', channel_team: TEAM, channel_private: false,
              channel_archived: null, channel_bot_id: null, channel_kind: 'channel', author_kind: 'person', author_name: 'Nadia', carries_answer: false, is_handoff_card: false,
              is_channel_copy: false, is_poll: false, voice_state: world.voice,
            },
          ],
        };
      }
      if (sql.includes("type = 'channel.message.transcribed'")) return { rows: world.announced ? [{ '?column?': 1 }] : [] };
      if (sql.includes('FROM app.bots')) return { rows: [{ id: BOT, slug: 'coder', runtime: 'hermes', triggers: [{ type: 'channel_message' }] }] };
      if (sql.includes('FROM app.projects') || sql.includes('rehearsal_questions') || sql.includes('message_model_picks')) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  } as unknown as PluginTx;
  try {
    registerRouter(ctx);
  } catch {
    // the other routers in registerRouter need more of the context than this canned one has; only the message subscriptions matter here
  }
  return { posted: handlers.get('channel.message.posted')!, transcribed: handlers.get('channel.message.transcribed')!, jobs, tx };
}

describe('the router and a voice message', () => {
  it('subscribes to both events', () => {
    const r = rig({ body: 'x', voice: null, announced: false });
    expect(typeof r.posted).toBe('function');
    expect(typeof r.transcribed).toBe('function');
  });

  it('a message that is not a voice message is routed on posted, as before; the transcribed event for it starts nothing', async () => {
    const r = rig({ body: 'Please help', voice: null, announced: false });
    await r.posted(posted(), r.tx);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.queue).toBe(RUN_QUEUE);
    await r.transcribed(transcribed('server'), r.tx);
    expect(r.jobs).toHaveLength(1);
  });

  it('a voice message being transcribed (pending) starts nothing on posted', async () => {
    const r = rig({ body: 'Voice message (0:42)', voice: 'pending', announced: false });
    await r.posted(posted(), r.tx);
    expect(r.jobs).toEqual([]);
  });

  it('routes once, on the transcribed event, with the transcript as its text', async () => {
    const world: World = { body: 'Please review the plan.', voice: 'server', announced: true };
    const r = rig(world);
    await r.transcribed(transcribed('server'), r.tx);
    expect(r.jobs).toHaveLength(1);
    const payload = RunPayload.parse(r.jobs[0]!.payload);
    expect(payload.text).toBe('Please review the plan.');
    expect(payload.prompt).toContain('Please review the plan.');
    expect(r.jobs[0]!.opts).toEqual({ dedupeKey: `runtime-hermes:${BOT}:${MSG}` });
    // a late `posted` for the same message (the outbox delivers it after the transcript is written) starts nothing more
    await r.posted(posted(), r.tx);
    expect(r.jobs).toHaveLength(1);
  });

  it('a late posted delivery that arrives after the transcript was written is left alone; one that arrives before the event exists is left alone while pending', async () => {
    const afterWrite = rig({ body: 'Words.', voice: 'server', announced: true });
    await afterWrite.posted(posted(), afterWrite.tx);
    expect(afterWrite.jobs).toEqual([]);
    const failed = rig({ body: 'Voice message (0:42)', voice: 'failed', announced: true });
    await failed.posted(posted(), failed.tx);
    expect(failed.jobs).toEqual([]);
  });

  it('a failed or "none" transcript routes with the stand-in line, as a message that never had one', async () => {
    for (const [state, voice] of [['failed', 'failed'], ['none', 'none']] as const) {
      const r = rig({ body: 'Voice message (0:42)', voice, announced: true });
      await r.transcribed(transcribed(state), r.tx);
      expect(r.jobs, state).toHaveLength(1);
      expect(RunPayload.parse(r.jobs[0]!.payload).text).toBe('Voice message (0:42)');
    }
  });

  it('a voice message that never went to the server (an old client\'s own words, or the switch was off at the post) is routed on posted as any message is', async () => {
    for (const voice of ['device', 'edited']) {
      const r = rig({ body: 'Words from the phone.', voice, announced: false });
      await r.posted(posted(), r.tx);
      expect(r.jobs, voice).toHaveLength(1);
    }
    // "none" with no event ever written (the switch was off at the post): no event will come, so posted routes it
    const none = rig({ body: 'Voice message (0:42)', voice: 'none', announced: false });
    await none.posted(posted(), none.tx);
    expect(none.jobs).toHaveLength(1);
  });
});
