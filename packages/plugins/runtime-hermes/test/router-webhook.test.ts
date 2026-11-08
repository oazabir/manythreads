import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerWebhookRouter, webhookKindMatches } from '../src/router-webhook.ts';
import { RUN_QUEUE, RunPayload } from '../src/run-job.ts';

// The `webhook` trigger, the router's side (PLAN P16-10): the announcement of a stored delivery starts one run per bot that listens for this address and this kind, and only
// when every fact it names still holds. The database is a canned one: each query answers by the table it reads.

const WS = '00000000-0000-7000-8000-00000000a001';
const TEAM = '00000000-0000-7000-8000-0000000b0001';
const CHANNEL = '00000000-0000-7000-8000-000000000002';
const HOOK = '00000000-0000-7000-8000-000000000010';
const EVENT = '00000000-0000-7000-8000-000000000011';
const BOT = '00000000-0000-7000-8000-000000000001';
const BOT2 = '00000000-0000-7000-8000-000000000003';

const announcement = (over: Record<string, unknown> = {}): PluginEvent =>
  ({ type: 'webhooks.provider_event.received', schemaVersion: 1, workspaceId: WS, teamId: TEAM, channelId: CHANNEL, webhookId: HOOK, eventId: EVENT, provider: 'zendesk', kind: 'ticket.created', at: '2026-11-02T08:00:00.000Z', ...over }) as unknown as PluginEvent;

interface Bot {
  id: string;
  slug: string;
  name: string;
  triggers: unknown[] | null;
  actor_id: string;
}
interface World {
  event: Record<string, unknown> | undefined;
  bots: Bot[];
  canPost: Set<string>;
  recent: number;
  latched: Set<string>;
}
const bot = (id: string, slug: string, triggers: unknown[] | null): Bot => ({ id, slug, name: slug.toUpperCase(), triggers, actor_id: `actor-${id}` });
const fresh = (over: Partial<World> = {}): World => ({
  event: {
    id: EVENT,
    webhook_id: HOOK,
    team_id: TEAM,
    channel_id: CHANNEL,
    provider: 'zendesk',
    kind: 'ticket.created',
    title: 'Printer on fire',
    url: 'https://example.zendesk.com/agent/tickets/4512',
    actor_label: 'Hana Okafor',
    payload: { sha256: 'abc', data: { id: 4512 } },
    received_at: new Date('2026-11-02T08:00:00.000Z'),
    slug: 'zendesk',
    name: 'Zendesk',
    revoked_at: null,
    live: true,
  },
  bots: [bot(BOT, 'support-responder', [{ type: 'webhook', connection: 'zendesk', event: 'ticket.created' }])],
  canPost: new Set([`actor-${BOT}`, `actor-${BOT2}`]),
  recent: 0,
  latched: new Set(),
  ...over,
});

function rig(world: World) {
  const jobs: Array<{ queue: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const emitted: Array<Record<string, unknown>> = [];
  let handler: ((e: PluginEvent, tx: PluginTx) => Promise<void>) | null = null;
  let clock = Date.parse('2026-11-02T08:00:00.000Z');
  const ctx = {
    events: { subscribe: (type: string, fn: typeof handler) => { expect(type).toBe('webhooks.provider_event.received'); handler = fn; } },
    jobs: { enqueue: async (_tx: unknown, queue: string, payload: Record<string, unknown>, opts: Record<string, unknown>): Promise<void> => { jobs.push({ queue, payload, opts }); } },
    audit: { emit: async (_tx: unknown, e: Record<string, unknown>): Promise<void> => void emitted.push(e) },
    runtime: { now: () => new Date(clock) },
  } as unknown as PluginContext;
  const tx = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM app.webhook_provider_events')) return { rows: world.event ? [world.event] : [] };
      if (sql.includes('FROM app.bots')) return { rows: world.bots };
      if (sql.includes('app.channel_actor_can_post')) return { rows: [{ ok: world.canPost.has(String(params[0])) }] };
      if (sql.includes('FROM app.outbox_processed')) return { rows: [{ n: String(world.recent) }] };
      if (sql.includes('INSERT INTO app.outbox_processed')) {
        const key = `${String(params[0])}|${String(params[1])}`;
        if (world.latched.has(key)) return { rows: [] };
        world.latched.add(key);
        return { rows: [{ ok: 1 }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  } as unknown as PluginTx;
  registerWebhookRouter(ctx);
  return { handler: handler as unknown as (e: PluginEvent, tx: PluginTx) => Promise<void>, jobs, emitted, tx, advance: (ms: number) => void (clock += ms) };
}

describe('webhookKindMatches', () => {
  it('takes an exact kind or a pattern under a dot', () => {
    expect(webhookKindMatches('ticket.created', 'ticket.created')).toBe(true);
    expect(webhookKindMatches('ticket.created', 'ticket.updated')).toBe(false);
    expect(webhookKindMatches('ticket.*', 'ticket.updated')).toBe(true);
    expect(webhookKindMatches('ticket.*', 'ticketing.created')).toBe(false);
    expect(webhookKindMatches('ticket.*', 'ticket')).toBe(false);
  });
});

describe('registerWebhookRouter', () => {
  it('starts one run for the bot that lists the trigger: no asker, no reply root, the channel of the address, the event id in the payload', async () => {
    const r = rig(fresh());
    await r.handler(announcement(), r.tx);
    expect(r.jobs).toHaveLength(1);
    const job = r.jobs[0]!;
    expect(job.queue).toBe(RUN_QUEUE);
    expect(job.payload).toMatchObject({ workspaceId: WS, botId: BOT, teamId: TEAM, channelId: CHANNEL, trigger: 'webhook', askerActorId: null, replyRootId: null, runThreadId: null, webhook: { eventId: EVENT } });
    expect(() => RunPayload.parse(job.payload)).not.toThrow();
    expect(job.opts).toEqual({ dedupeKey: `runtime-hermes:${BOT}:webhook:${EVENT}` });
    // the app's words are fenced as outside data
    const prompt = String(job.payload['prompt']);
    expect(prompt).toContain('<<<BEGIN APP TEXT>>>');
    expect(prompt).toContain('title: Printer on fire');
    expect(prompt).toContain('- kind: ticket.created');
  });

  it('a second delivery of the same announcement starts nothing more', async () => {
    const w = fresh();
    const r = rig(w);
    await r.handler(announcement(), r.tx);
    await r.handler(announcement(), r.tx);
    expect(r.jobs).toHaveLength(1);
  });

  it('a bot without the trigger gets nothing, and so does one that names another address or another kind', async () => {
    const r = rig(
      fresh({
        bots: [
          bot(BOT, 'plain', [{ type: 'mention' }]),
          bot(BOT2, 'other-address', [{ type: 'webhook', connection: 'github' }]),
          bot('00000000-0000-7000-8000-000000000004', 'other-kind', [{ type: 'webhook', connection: 'zendesk', event: 'ticket.deleted' }]),
          bot('00000000-0000-7000-8000-000000000005', 'no-connection', [{ type: 'webhook' }]),
          bot('00000000-0000-7000-8000-000000000006', 'no-triggers', null),
        ],
      }),
    );
    await r.handler(announcement(), r.tx);
    expect(r.jobs).toHaveLength(0);
  });

  it('a pattern in the trigger matches every kind under it, and a trigger without a kind takes any', async () => {
    const r = rig(
      fresh({
        bots: [bot(BOT, 'glob', [{ type: 'webhook', connection: 'zendesk', event: 'ticket.*' }]), bot(BOT2, 'any', [{ type: 'webhook', connection: 'zendesk' }])],
      }),
    );
    await r.handler(announcement(), r.tx);
    expect(r.jobs.map((j) => j.payload['botId']).sort()).toEqual([BOT, BOT2].sort());
  });

  it('starts nothing when the stored event is gone, was switched off, or disagrees with the announcement', async () => {
    for (const w of [
      fresh({ event: undefined }),
      fresh({ event: { ...fresh().event!, revoked_at: new Date() } }),
      fresh({ event: { ...fresh().event!, live: false } }),
      fresh({ event: { ...fresh().event!, channel_id: '00000000-0000-7000-8000-0000000000ff' } }),
      fresh({ event: { ...fresh().event!, kind: 'ticket.deleted' } }),
    ]) {
      const r = rig(w);
      await r.handler(announcement(), r.tx);
      expect(r.jobs).toHaveLength(0);
    }
  });

  it('a bot that may not post in the channel gets no run, and the lead is told once a minute', async () => {
    const r = rig(fresh({ canPost: new Set() }));
    await r.handler(announcement(), r.tx);
    await r.handler(announcement(), r.tx);
    await r.handler(announcement(), r.tx);
    expect(r.jobs).toHaveLength(0);
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ type: 'webhooks.provider_event.refused', reason: 'no_channel', count: 1, webhookId: HOOK });
    r.advance(61_000);
    await r.handler(announcement(), r.tx);
    expect(r.emitted).toHaveLength(2);
    expect(r.emitted[1]).toMatchObject({ reason: 'no_channel', count: 3 });
  });

  it('a bot over 30 runs an hour is dropped, and the lead is told once a minute', async () => {
    const r = rig(fresh({ recent: 30 }));
    await r.handler(announcement(), r.tx);
    await r.handler(announcement({ eventId: '00000000-0000-7000-8000-000000000012' }), r.tx);
    expect(r.jobs).toHaveLength(0);
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]).toMatchObject({ reason: 'bot_busy', count: 1 });
  });

  it('one under the cap still runs', async () => {
    const r = rig(fresh({ recent: 29 }));
    await r.handler(announcement(), r.tx);
    expect(r.jobs).toHaveLength(1);
  });
});
