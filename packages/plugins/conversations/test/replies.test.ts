import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { ChannelMessagePostedEvent } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { TITLE_QUEUE, recordReply } from '../src/replies.ts';

// The bot's answer becomes a variant of its turn (PLAN P20-16, P20-T4), with the database canned: only a bot's own answer in a person's conversation counts, once per
// run; the turn is what the run recorded or else the person's last message before the answer; the first answer of a conversation asks for a title, later ones do not.

const WS = '00000000-0000-7000-8000-00000000a001';
const PERSON = '00000000-0000-7000-8000-0000000e0001';
const ROOT = '00000000-0000-7000-8000-000000000003';
const REPLY = '00000000-0000-7000-8000-000000000005';
const TURN = '00000000-0000-7000-8000-000000000004';
const RUN = '00000000-0000-7000-8000-0000000c0001';
const WHEN = new Date('2026-11-01T10:00:00Z');

const event = (over: Partial<ChannelMessagePostedEvent> = {}): ChannelMessagePostedEvent => ({ messageId: REPLY, threadRootId: ROOT, ...over }) as unknown as ChannelMessagePostedEvent;

interface World {
  reply: { person_id: string; workspace_id: string; created_at: Date; run_id: string | null } | undefined;
  seen: boolean;
  run: { turn_message_id: string | null; model_alias: string | null; stopped_by_asker: boolean } | undefined;
  lastPerson: string | undefined;
  before: number;
  inserted: boolean;
}

const fresh = (over: Partial<World> = {}): World => ({
  reply: { person_id: PERSON, workspace_id: WS, created_at: WHEN, run_id: RUN },
  seen: false,
  run: { turn_message_id: TURN, model_alias: 'fast', stopped_by_asker: false },
  lastPerson: TURN,
  before: 0,
  inserted: true,
  ...over,
});

function rig(world: World) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const jobs: Array<{ queue: string; payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('JOIN app.conversations c ON c.thread_root_id')) return { rows: world.reply ? [world.reply] : [] };
      if (sql.includes('SELECT 1 FROM app.conversation_variants WHERE run_id')) return { rows: world.seen ? [{}] : [] };
      if (sql.includes('FROM app.bot_runs WHERE id')) return { rows: world.run ? [world.run] : [] };
      if (sql.includes("a.kind = 'person'")) return { rows: world.lastPerson ? [{ id: world.lastPerson }] : [] };
      if (sql.includes('count(*)::text')) return { rows: [{ n: String(world.before) }] };
      if (sql.includes('INSERT INTO app.conversation_variants')) return { rows: world.inserted ? [{}] : [] };
      throw new Error(`unexpected query ${sql.slice(0, 50)}`);
    },
  } as unknown as PluginTx;
  const ctx = { jobs: { enqueue: async (_tx: unknown, queue: string, payload: Record<string, unknown>, opts: Record<string, unknown>) => { jobs.push({ queue, payload, opts }); } } } as unknown as PluginContext;
  return { run: (e = event()) => recordReply(ctx, e, tx), queries, jobs, insert: () => queries.find((q) => q.sql.includes('INSERT INTO app.conversation_variants')) };
}

describe('recordReply', () => {
  it('files a bot’s answer as the next variant of the turn the run recorded, with the model and the stop, and asks for a title the first time', async () => {
    const r = rig(fresh({ run: { turn_message_id: TURN, model_alias: 'fast', stopped_by_asker: true } }));
    await r.run();
    expect(r.insert()?.params).toEqual([REPLY, TURN, ROOT, WS, PERSON, 'fast', true, RUN]);
    expect(r.insert()?.sql).toMatch(/chosen = false WHERE turn_message_id/);
    expect(r.insert()?.sql).toMatch(/ON CONFLICT \(reply_message_id\) DO NOTHING/);
    expect(r.jobs).toEqual([{ queue: TITLE_QUEUE, payload: { workspaceId: WS, threadRootId: ROOT }, opts: { dedupeKey: `conversations-title:${ROOT}` } }]);
  });

  it('does not ask for a title again for the second answer of a conversation', async () => {
    const r = rig(fresh({ before: 1 }));
    await r.run();
    expect(r.insert()).toBeDefined();
    expect(r.jobs).toHaveLength(0);
  });

  it('files nothing and asks for nothing when the insert found the answer already filed', async () => {
    const r = rig(fresh({ inserted: false }));
    await r.run();
    expect(r.jobs).toHaveLength(0);
  });

  it('finds the turn from the thread when the run did not record it: the person’s last message before the answer', async () => {
    const r = rig(fresh({ run: { turn_message_id: null, model_alias: null, stopped_by_asker: false }, lastPerson: ROOT }));
    await r.run();
    expect(r.insert()?.params).toEqual([REPLY, ROOT, ROOT, WS, PERSON, null, false, RUN]);
    const lookup = r.queries.find((q) => q.sql.includes("a.kind = 'person'"));
    expect(lookup?.params).toEqual([ROOT, WHEN]);
  });

  it('files nothing when there is no turn to attach it to', async () => {
    const r = rig(fresh({ run: { turn_message_id: null, model_alias: null, stopped_by_asker: false }, lastPerson: undefined }));
    await r.run();
    expect(r.insert()).toBeUndefined();
    expect(r.jobs).toHaveLength(0);
  });

  const nothing: Array<[string, Partial<World>, Partial<ChannelMessagePostedEvent>?]> = [
    ['the message is not in a thread', {}, { threadRootId: null }],
    ['the message is not a bot’s answer in a person’s conversation (no row)', { reply: undefined }],
    ['the answer carries no run', { reply: { person_id: PERSON, workspace_id: WS, created_at: WHEN, run_id: null } }],
    ['the run id is not an id', { reply: { person_id: PERSON, workspace_id: WS, created_at: WHEN, run_id: 'not-a-uuid' } }],
    ['the run already has its answer (it posted twice: a tool’s post, then the final text)', { seen: true }],
    ['the run is not known', { run: undefined }],
  ];
  for (const [name, over, ev] of nothing) {
    it(`files nothing when ${name}`, async () => {
      const r = rig(fresh(over));
      await r.run(event(ev));
      expect(r.insert()).toBeUndefined();
      expect(r.jobs).toHaveLength(0);
    });
  }

  it('asks the database only about answers: a failure notice and a deleted message are left out by the first query', async () => {
    const r = rig(fresh());
    await r.run();
    const first = r.queries[0]?.sql ?? '';
    expect(first).toMatch(/m\.deleted_at IS NULL/);
    expect(first).toMatch(/NOT \(m\.meta \? 'runFailure'\)/);
    expect(first).toMatch(/a\.kind = 'bot'/);
  });
});
