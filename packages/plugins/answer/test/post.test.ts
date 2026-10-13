import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { postAnswer } from '../src/post.ts';

// The wording of what `answer.post` tells the model (P5-18 review: the "log is cut" sentence had no test). No database: the SQL view is a fake
// answer, the message provider a recorder; the whole path is test/answer.test.ts.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const run = (over: Record<string, unknown> = {}) => ({
  runId: uuid(1),
  botId: uuid(2),
  botName: 'Brain',
  botSlug: 'brain',
  alias: 'smart',
  teamId: uuid(3),
  workspaceId: uuid(4),
  trigger: 'conversation',
  hasAsker: true,
  askerPersonId: uuid(5),
  askerName: 'Nadia',
  channelId: uuid(6),
  replyRootId: uuid(7),
  private: true,
  reach: 'asker',
  ...over,
});

const harness = (view: Record<string, unknown>) => {
  const posted: unknown[] = [];
  const events: unknown[] = [];
  const ctx = {
    providers: {
      get: () => ({
        id: 'channels',
        post: async (_tx: unknown, input: unknown) => {
          posted.push(input);
          return { id: uuid(50), channelId: uuid(6), threadRootId: uuid(7), createdAt: '2026-10-01T12:00:00.000Z' };
        },
      }),
    },
    audit: { emit: async (_tx: unknown, event: unknown) => void events.push(event) },
  } as unknown as PluginContext;
  const tx = { query: async () => ({ rows: [{ v: view }] }) } as unknown as PluginTx;
  return { ctx, tx, posted, events };
};

const MISSING = { found: false, reached: false };

describe('what the tool says when a long log cut what the run read', () => {
  it('names the cut when citations were removed from a run whose log was longer than the view reads', async () => {
    const h = harness({ run: run({ logTruncated: true }), citations: [MISSING], sources: [], bots: [] });
    const out = await postAnswer(h.ctx, h.tx, { body: 'Something [1].', citations: [{ kind: 'message', messageId: uuid(30) }] });
    expect(out).toMatchObject({ ok: true, citationsKept: 0, citationsRemoved: 1 });
    if (!out.ok) throw new Error('expected a post');
    expect(out.message).toContain('1 citation(s) were removed');
    expect(out.message).toContain('the log is cut');
    expect(out.message).toContain('a source read late may be among those removed');
    expect(h.posted).toHaveLength(1);
  });

  it('says nothing of a cut when the log was read whole', async () => {
    const h = harness({ run: run({ logTruncated: false }), citations: [MISSING], sources: [], bots: [] });
    const out = await postAnswer(h.ctx, h.tx, { body: 'Something [1].', citations: [{ kind: 'message', messageId: uuid(30) }] });
    expect(out).toMatchObject({ ok: true, citationsRemoved: 1 });
    if (!out.ok) throw new Error('expected a post');
    expect(out.message).toContain('1 citation(s) were removed');
    expect(out.message).not.toContain('the log is cut');
  });

  it('a field the view does not carry at all (a run view from before the cap) reads as not cut', async () => {
    const h = harness({ run: run(), citations: [MISSING], sources: [], bots: [] });
    const out = await postAnswer(h.ctx, h.tx, { body: 'Something [1].', citations: [{ kind: 'message', messageId: uuid(30) }] });
    if (!out.ok) throw new Error('expected a post');
    expect(out.message).not.toContain('the log is cut');
  });

  it('a cut log with nothing removed is a plain success: there is nothing the cut could have dropped', async () => {
    const h = harness({ run: run({ logTruncated: true }), citations: [], sources: [], bots: [] });
    const out = await postAnswer(h.ctx, h.tx, { body: 'No sources at all.' });
    expect(out).toEqual({ ok: true, messageId: uuid(50), citationsKept: 0, citationsRemoved: 0, message: 'Posted as your reply. Do not post it again.' });
  });
});
