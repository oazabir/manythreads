import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerConsumers } from '../src/consumers.ts';

// The subscriptions without a database: what a commit marks. Set-based and without a cap — a commit that touches more than two hundred pages must
// leave none of them behind (a document of a page the commit rewrote or deleted would stay in the bank).

const TEAM = '00000000-0000-7000-8000-0000000b0001';
const WS = '00000000-0000-7000-8000-00000000a001';

function harness(enabled = true) {
  const handlers = new Map<string, (event: PluginEvent, tx: PluginTx) => Promise<void>>();
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const jobs: string[] = [];
  const ctx = {
    events: { subscribe: (type: string, handler: (event: PluginEvent, tx: PluginTx) => Promise<void>) => void handlers.set(type, handler) },
    providers: { get: () => ({ id: 'stub', enabled }) },
    jobs: { enqueue: (_tx: PluginTx, queue: string) => Promise.resolve(void jobs.push(queue)).then(() => 'job') },
    runtime: { now: () => new Date('2026-10-12T09:00:00.000Z') },
  } as unknown as PluginContext;
  registerConsumers(ctx);
  const tx = {
    actor: { kind: 'system', id: 'x', workspaceId: WS },
    query: (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PluginTx;
  return { handlers, queries, jobs, tx };
}

const committed = (paths: Array<{ path: string; op: 'put' | 'delete' }>): PluginEvent => ({
  type: 'repo.repo.committed',
  schemaVersion: 1,
  workspaceId: WS,
  teamId: TEAM,
  sha: 'a'.repeat(40),
  parentSha: null,
  authorId: null,
  coAuthorIds: [],
  subject: 'x',
  paths,
});

describe('repo.repo.committed', () => {
  it('marks every pages/ path of the commit, put or delete, in one statement — 250 pages is 250 sources', async () => {
    const h = harness();
    const paths = [
      ...Array.from({ length: 250 }, (_, i) => ({ path: `pages/bulk/${i}.md`, op: (i % 3 === 0 ? 'delete' : 'put') as 'put' | 'delete' })),
      { path: 'TEAM.md', op: 'put' as const },
      { path: 'bots/x/BOT.md', op: 'put' as const },
    ];
    await h.handlers.get('repo.repo.committed')!(committed(paths), h.tx);
    const inserts = h.queries.filter((q) => /INSERT INTO app\.memory_feed_pending/.test(q.text));
    expect(inserts).toHaveLength(1);
    const [kinds, ids] = inserts[0]!.values as [string[], string[]];
    expect(kinds).toEqual(Array.from({ length: 250 }, () => 'page'));
    expect(ids).toHaveLength(250);
    expect(ids[0]).toBe(`${TEAM}/pages/bulk/0.md`);
    expect(ids.every((id) => id.startsWith(`${TEAM}/pages/`))).toBe(true);
    expect(h.jobs).toEqual(['memory.feed']);
  });

  it('a commit that touches no page marks nothing and queues nothing', async () => {
    const h = harness();
    await h.handlers.get('repo.repo.committed')!(committed([{ path: 'TEAM.md', op: 'put' }]), h.tx);
    expect(h.queries).toEqual([]);
    expect(h.jobs).toEqual([]);
  });

  it('no longer subscribes to pages.page.written: the commit event is the one every path emits', () => {
    expect([...harness().handlers.keys()]).not.toContain('pages.page.written');
  });
});

describe('messages', () => {
  it('a reply marks its thread and the root; a DM (no team) marks nothing', async () => {
    const h = harness();
    const base = { schemaVersion: 1, workspaceId: WS, channelId: '00000000-0000-7000-8000-0000000e0001', teamId: TEAM, authorId: '00000000-0000-7000-8000-0000000d0002', threadRootId: '00000000-0000-7000-8000-0000000f0001', messageId: '00000000-0000-7000-8000-0000000f0002' };
    const txPublic = {
      ...h.tx,
      query: (text: string, values: readonly unknown[] = []) => {
        h.queries.push({ text, values });
        return Promise.resolve({ rows: /FROM app\.channels/.test(text) ? [{ ok: true }] : [] });
      },
    } as unknown as PluginTx;
    await h.handlers.get('channel.message.posted')!({ type: 'channel.message.posted', ...base }, txPublic);
    const marks = h.queries.filter((q) => /INSERT INTO app\.memory_feed_pending/.test(q.text));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.values[0]).toEqual(['thread', 'message']);
    expect(marks[0]!.values[1]).toEqual([base.threadRootId, base.threadRootId]);

    const before = h.queries.length;
    await h.handlers.get('channel.message.posted')!({ type: 'channel.message.posted', ...base, teamId: null }, txPublic);
    expect(h.queries.length).toBe(before);
  });
});
