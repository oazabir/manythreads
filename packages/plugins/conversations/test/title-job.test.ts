import type { JobInfo, PluginContext, PluginTx } from '@manythreads/sdk';
import { CHAT_TITLE_MAX } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { TITLE_QUEUE } from '../src/replies.ts';
import { registerTitleJob } from '../src/title.ts';

// The job that names a conversation after its first answer (PLAN P20-16, P20-T4), with the model door, the database and the audit canned: it names only a chat that
// has no title of the person's own, asks the cheap model with the start of the conversation, and leaves the title empty when the model cannot help.

const WS = '00000000-0000-7000-8000-00000000a001';
const ROOT = '00000000-0000-7000-8000-000000000003';
const BOT = '00000000-0000-7000-8000-000000000001';
const TEAM = '00000000-0000-7000-8000-0000000b0001';
const PERSON = '00000000-0000-7000-8000-0000000e0001';
const CHANNEL = '00000000-0000-7000-8000-000000000002';

type Llm = { ok: true; text: string } | { ok: false; reason: string; detail: string };

function rig(over: { seen?: { bot_id: string; team_id: string; first: string; answer: string | null } | null; llm?: Llm | null; updated?: boolean } = {}) {
  const seen = over.seen === undefined ? { bot_id: BOT, team_id: TEAM, first: 'What is blocking the release?', answer: 'The QA batch.' } : over.seen;
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT c.bot_id')) return { rows: seen ? [seen] : [] };
      if (sql.includes('UPDATE app.conversations')) {
        updates.push({ sql, params });
        return { rows: over.updated === false ? [] : [{ person_id: PERSON, bot_id: BOT, channel_id: CHANNEL }] };
      }
      throw new Error(`unexpected query ${sql.slice(0, 40)}`);
    },
  } as unknown as PluginTx;
  const llmDoor =
    over.llm === null
      ? undefined
      : { evalComplete: async (_tx: unknown, request: Record<string, unknown>) => { requests.push(request); return over.llm ?? ({ ok: true, text: 'Release blockers' } as Llm); } };
  let handler: ((raw: unknown, tx: PluginTx, job: JobInfo) => Promise<void>) | null = null;
  let registered: { queue: string; opts: Record<string, unknown> } | null = null;
  const ctx = {
    jobs: { register: (queue: string, fn: typeof handler, opts: Record<string, unknown>) => { registered = { queue, opts }; handler = fn; } },
    providers: { get: (name: string) => (name === 'llm' ? llmDoor : undefined) },
    audit: { emit: async (_tx: unknown, event: Record<string, unknown>) => { audits.push(event); } },
  } as unknown as PluginContext;
  registerTitleJob(ctx);
  const job = { transaction: async <T>(fn: (t: PluginTx) => Promise<T>): Promise<T> => fn(tx), log: { info: (m: string) => logs.push(m) } } as unknown as JobInfo;
  return { run: (payload: unknown = { workspaceId: WS, threadRootId: ROOT }) => handler!(payload, tx, job), updates, audits, requests, logs, registered: () => registered };
}

describe('the title job', () => {
  it('is registered on its queue, detached, so no transaction is held while the model works', () => {
    const r = rig();
    expect(r.registered()?.queue).toBe(TITLE_QUEUE);
    expect(r.registered()?.opts).toMatchObject({ detached: true, maxAttempts: 3 });
  });

  it('asks the fast model for at most six words about the start of the conversation, and records its answer as the auto title', async () => {
    const r = rig();
    await r.run();
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ workspaceId: WS, botId: BOT, teamId: TEAM, alias: 'fast', purpose: 'title', maxTokens: 24 });
    expect(String(r.requests[0]?.['user'])).toBe('Person: What is blocking the release?\n\nBot: The QA batch.');
    expect(String(r.requests[0]?.['system'])).toMatch(/at most six words/);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]?.params).toEqual([ROOT, 'Release blockers']);
    expect(r.updates[0]?.sql).toMatch(/title_source IS NULL AND deleted_at IS NULL/);
    expect(r.audits).toEqual([
      { type: 'conversations.conversation.renamed', botId: BOT, personId: PERSON, channelId: CHANNEL, threadRootId: ROOT, source: 'auto' },
    ]);
  });

  it('sends the person’s words alone when there is no answer yet', async () => {
    const r = rig({ seen: { bot_id: BOT, team_id: TEAM, first: 'Hello', answer: null } });
    await r.run();
    expect(r.requests[0]?.['user']).toBe('Person: Hello');
  });

  it('cleans what the model wrote before it becomes the title', async () => {
    const r = rig({ llm: { ok: true, text: 'Title: "Release blockers."\nBecause...' } });
    await r.run();
    expect(r.updates[0]?.params).toEqual([ROOT, 'Release blockers']);
    const long = rig({ llm: { ok: true, text: 'word '.repeat(60) } });
    await long.run();
    expect(String(long.updates[0]?.params[1]).length).toBeLessThanOrEqual(CHAT_TITLE_MAX);
  });

  it('does nothing for a conversation that has a title of the person’s own, is deleted or is gone', async () => {
    const r = rig({ seen: null });
    await r.run();
    expect(r.requests).toHaveLength(0);
    expect(r.updates).toHaveLength(0);
  });

  it('leaves the title empty without a model door', async () => {
    const r = rig({ llm: null });
    await r.run();
    expect(r.updates).toHaveLength(0);
    expect(r.audits).toHaveLength(0);
  });

  it('leaves the title empty when the gateway refuses, and logs why in one line', async () => {
    const r = rig({ llm: { ok: false, reason: 'no_alias', detail: 'fast has no model' } });
    await r.run();
    expect(r.updates).toHaveLength(0);
    expect(r.logs).toEqual([`conversations: no title for ${ROOT}: no_alias`]);
  });

  it('leaves the title empty when the model wrote nothing usable', async () => {
    for (const text of ['', '   \n ', '""', 'Title:']) {
      const r = rig({ llm: { ok: true, text } });
      await r.run();
      expect(r.updates, JSON.stringify(text)).toHaveLength(0);
    }
  });

  it('records nothing when the person named the chat while the model worked (the update finds no row)', async () => {
    const r = rig({ updated: false });
    await r.run();
    expect(r.updates).toHaveLength(1);
    expect(r.audits).toHaveLength(0);
  });

  it('refuses a payload that is not a workspace and a thread', async () => {
    const r = rig();
    await expect(r.run({ workspaceId: 'x', threadRootId: ROOT })).rejects.toThrow();
    await expect(r.run({})).rejects.toThrow();
  });
});
