// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ThreadInboxItem, ThreadMention, ThreadTodo } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P29-16: a Threads row. The first message is the head; the reply count divides; ONE block follows (the latest reply, or, when it names the person, the same block in the mention's look).
// A mention that is older than the latest reply comes first and the latest follows. No replies, no block. The filter bar clears with its button and with Escape.

vi.mock('../src/channels/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePeople: () => ({ byActor: () => undefined, botAvatar: () => undefined, botName: () => undefined, list: [], bots: [] }),
}));
vi.mock('../src/later/RemindMenu', () => ({ useLater: () => ({}), laterErrorText: () => '' }));
vi.mock('../src/later/store', () => ({ laterStore: { itemFor: () => undefined, load: async () => undefined, save: async () => undefined, remove: async () => undefined } }));
vi.mock('../src/api/endpoints', async (importOriginal) => ({ ...(await importOriginal<object>()), followThread: vi.fn(), unfollowThread: vi.fn() }));
const { ThreadCard } = await import('../src/screens/ThreadCard');
const { FilterBar } = await import('../src/inbox/FilterBar');
const { NOT_NEEDED, needsYou } = await import('../src/inbox/rules');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-16T10:00:00.000Z';
const item = (over: Partial<ThreadInboxItem> = {}): ThreadInboxItem =>
  ({
    rootMessageId: ID(1), channel: { id: ID(9), name: 'releases', kind: 'channel' }, title: 'Cut over to the EU region', rootAuthorId: ID(5), replyCount: 3, lastReplyAt: AT,
    followed: true, unreadCount: 0, mine: false, rootAuthor: { displayName: 'Nadia' }, participants: [], participantCount: 0, mentionCount: 0,
    lastReply: { authorName: 'Rafi', preview: 'will do it tonight', messageId: ID(20), authorId: ID(6), kind: 'person', at: AT }, mention: null, ...over,
  }) as unknown as ThreadInboxItem;
const mention = (over: Record<string, unknown> = {}): ThreadMention => ({ messageId: ID(30), authorId: ID(7), authorName: 'Sam', kind: 'person', at: AT, preview: '@me can you decide?', ...over }) as unknown as ThreadMention;
const todo = (): ThreadTodo =>
  ({ rootId: ID(1), title: 'Ship', version: 1, updatedAt: AT, items: [{ id: 'a', text: 'Migration', status: 'done' }, { id: 'b', text: 'Run lint', status: 'working' }, { id: 'c', text: 'PR', status: 'waiting' }, { id: 'd', text: 'Deploy', status: 'waiting' }] }) as unknown as ThreadTodo;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];
const draw = async (it: ThreadInboxItem, extra: Record<string, unknown> = {}): Promise<void> => {
  await act(async () => {
    root.render(createElement('ul', null, createElement(ThreadCard, { item: it, teamSlug: 'engineering', selected: false, onOpen: vi.fn(), onMarkRead: vi.fn(), onChanged: vi.fn(), onOpenInChannel: vi.fn(), ...extra })));
  });
};

describe('the blocks under the reply count', () => {
  it('shows ONE "Latest reply" block with the replier and the text, when nobody mentions the person', async () => {
    await draw(item());
    const blocks = qa('.thc-blk');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.getAttribute('data-kind')).toBe('latest');
    expect(blocks[0]?.textContent).toContain('Latest reply');
    expect(blocks[0]?.textContent).toContain('Rafi');
    expect(blocks[0]?.textContent).toContain('will do it tonight');
    expect(q('.thc-text')?.textContent).toBe('Cut over to the EU region'); // the head is the starting message
  });

  it('gives the latest reply one line for who and when, and the rest to its text (owner 2026-11-19)', async () => {
    await draw(item());
    const block = q('.thc-blk');
    // no visible label row: "Latest reply" is said to a screen reader inside the who line
    expect(block?.querySelector('.thc-blk-label')).toBeNull();
    expect(block?.querySelector('.thc-blk-who .sr-only')?.textContent).toContain('Latest reply');
    expect([...(block?.children ?? [])].map((c) => c.className)).toEqual(['thc-blk-who', 'thc-blk-text']);
  });

  it('takes the mention look, never two blocks, when the latest reply is the one that names the person', async () => {
    await draw(item({ mention: mention({ messageId: ID(20), authorName: 'Rafi', preview: 'will do it tonight' }) }));
    const blocks = qa('.thc-blk');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.getAttribute('data-kind')).toBe('mention');
    expect(blocks[0]?.textContent).toContain('Mentions you');
  });

  it('puts an older mention first and the latest reply after it', async () => {
    await draw(item({ mention: mention() }));
    expect(qa('.thc-blk').map((b) => b.getAttribute('data-kind'))).toEqual(['mention', 'latest']);
  });

  it('has no block when nobody replied', async () => {
    await draw(item({ replyCount: 0, lastReply: null }));
    expect(qa('.thc-blk')).toHaveLength(0);
  });
});

describe('the chip and the line of progress', () => {
  it('says "Needs you" and draws the amber chip when the row waits on the person', async () => {
    await draw(item({ mention: mention() }), { needs: needsYou(item({ mention: mention() }), []) });
    expect(q('[data-testid="thread-needs-you"]')).not.toBeNull();
    await draw(item(), { needs: NOT_NEEDED });
    expect(q('[data-testid="thread-needs-you"]')).toBeNull();
  });

  it('draws "2 of 4"... with the item being worked on, and a run alone as the bot and what it does', async () => {
    await draw(item(), { work: { todo: todo(), run: null, questions: [] } });
    expect(q('[data-testid="thread-progress"]')?.textContent).toContain('1 of 4');
    expect(q('[data-testid="thread-progress"]')?.textContent).toContain('Run lint');
    await draw(item(), { work: { todo: null, run: { botName: 'Engineer', head: { state: 'working', now: null } }, questions: [] } });
    expect(q('[data-testid="thread-progress"]')?.getAttribute('data-kind')).toBe('run');
    expect(q('[data-testid="thread-progress"]')?.textContent).toContain('Engineer');
    await draw(item());
    expect(q('[data-testid="thread-progress"]')).toBeNull();
  });

  it('marks the words of the filter in the channel and the text', async () => {
    await draw(item(), { words: ['eu', 'releases'] });
    expect(qa('mark.thc-hit').map((m) => m.textContent?.toLowerCase())).toEqual(expect.arrayContaining(['releases', 'eu']));
  });
});

describe('the filter bar', () => {
  const draw2 = async (value: string, onChange: (t: string) => void): Promise<void> => {
    await act(async () => {
      root.render(createElement(FilterBar, { value, onChange, needsFirst: true, onNeedsFirst: vi.fn(), status: null, layout: 'list', onLayout: vi.fn() }));
    });
  };

  it('clears with the x and with Escape, and has no x while empty', async () => {
    const onChange = vi.fn();
    await draw2('', onChange);
    expect(q('[data-testid="threads-filter-clear"]')).toBeNull();
    await draw2('deploy @nadia', onChange);
    await act(async () => (q('[data-testid="threads-filter-clear"]') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenLastCalledWith('');
    onChange.mockClear();
    await act(async () => {
      q('[data-testid="threads-filter-input"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('the grid card and the layout memory', () => {
  const approval = { id: 'a1', source: 'agent', status: 'pending', tool: 'approvals.ask', summary: 'Deploy to the test site?', argsPreview: {}, argsTruncated: false, botName: 'Engineer', requesterName: 'Engineer', createdAt: AT, channelId: ID(9), threadRootId: ID(1), approvers: { roles: [], people: [], leads: true }, canDecide: true, blockReason: null, decision: null };

  it('draws the card with the question and its buttons, the blocks and an open action that opens the thread', async () => {
    const { ThreadGridCard } = await import('../src/inbox/ThreadGridCard');
    const onOpen = vi.fn();
    const it = item({ mention: mention() });
    await act(async () => {
      root.render(createElement('ul', null, createElement(ThreadGridCard, { item: it, slug: 'engineering', onOpen, work: { todo: todo(), run: null, questions: [approval] as never }, needs: needsYou(it, [approval as never]) })));
    });
    expect(q('[data-testid="thread-card"]')).not.toBeNull();
    expect(q('[data-testid="tv-question-yes"]')).not.toBeNull();
    expect(q('[data-testid="thread-progress"]')?.textContent).toContain('1 of 4');
    expect(qa('.thc-blk').map((b) => b.getAttribute('data-kind'))).toEqual(['mention', 'latest']);
    await act(async () => (q('[data-testid="thread-card-open"]') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith(ID(1));
  });

  it('remembers the layout per person, and falls back to the list when storage is blocked', async () => {
    const { readLayout, writeLayout, forgetLayout } = await import('../src/inbox/viewMode');
    forgetLayout();
    localStorage.clear();
    expect(readLayout('p1')).toBe('list');
    writeLayout('p1', 'grid');
    expect(readLayout('p1')).toBe('grid');
    expect(readLayout('p2')).toBe('list');
    forgetLayout();
    expect(readLayout('p1')).toBe('grid'); // from storage
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    forgetLayout();
    expect(readLayout('p9')).toBe('list');
    spy.mockRestore();
  });
});
