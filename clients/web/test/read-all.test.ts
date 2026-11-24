import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shift+Esc (issue #28): a read position the server did not take is not counted as read, and a list longer than the pages read is reported, never claimed done.

let failOn = new Set<string>();
let pages = 1;
vi.mock('../src/api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchUnreadSummary: () => Promise.resolve({ channels: [{ channelId: 'c1' }, { channelId: 'c2' }], threads: [] }),
  fetchMessages: (channelId: string, o: { threadRootId?: string }) => Promise.resolve({ items: [{ id: `m-${o.threadRootId ?? channelId}` }], nextCursor: null }),
  fetchThreadInbox: (_slug: string, _f: string, cursor?: string) => {
    const n = cursor === undefined ? 0 : Number(cursor);
    return Promise.resolve({ items: [{ channel: { id: 'c1' }, rootMessageId: `t${n}` }], nextCursor: n + 1 < pages ? String(n + 1) : null });
  },
  markRead: (type: string, id: string, upTo: string) =>
    failOn.has(id) ? Promise.reject(new Error('down')) : Promise.resolve({ targetType: type, targetId: id, lastReadId: upTo, unreadCount: 0 }),
  fetchUnreadSummaryCounts: () => Promise.resolve({}),
}));

const { markEverythingRead, readAllWords, INBOX_PAGES } = await import('../src/app/readAll');
const { channelStore } = await import('../src/channels/store');

beforeEach(() => {
  failOn = new Set();
  pages = 1;
  vi.spyOn(channelStore, 'refreshSummary').mockResolvedValue(undefined as never);
});

describe('mark everything read', () => {
  it('counts only what the server took, and says what failed', async () => {
    failOn = new Set(['c2']);
    const r = await markEverythingRead('engineering');
    expect(r).toEqual({ marked: 2, failed: 1, more: false });
    expect(readAllWords(r)).toBe('Marked 2 as read; 1 could not be marked. Try again.');
  });

  it('goes through many pages, and says when unread threads are left', async () => {
    pages = 5;
    expect(await markEverythingRead('engineering')).toEqual({ marked: 7, failed: 0, more: false });
    pages = INBOX_PAGES + 3;
    const r = await markEverythingRead('engineering');
    expect(r.more).toBe(true);
    expect(readAllWords(r)).toContain('More unread threads are left');
  });

  it('says plainly when all is done or nothing was unread', () => {
    expect(readAllWords({ marked: 3, failed: 0, more: false })).toBe('Everything marked as read.');
    expect(readAllWords({ marked: 0, failed: 0, more: false })).toBe('Nothing was unread.');
  });
});
