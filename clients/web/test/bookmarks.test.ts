import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavContribution, type SavedBookmark } from '@manythreads/shared';

// P36-08: the pieces of Bookmarks that are not on screen: the client's copy of the keys (load, toggle with rollback, the push from another tab, a server
// without the plugin), the sidebar entry that shows only while there is a bookmark, where a click on a row leads, how a place reads, and the channel
// header's "Links" (renamed from bookmarks).

const api = vi.hoisted(() => ({ fetchBookmarkKeys: vi.fn(), saveBookmark: vi.fn(), removeSavedBookmark: vi.fn() }));
vi.mock('../src/api/endpoints', async (actual) => ({ ...(await actual<Record<string, unknown>>()), ...api }));
const socket = vi.hoisted(() => ({ push: null as null | ((p: { type: string; payload: unknown }) => void), reconnect: null as null | (() => void) }));
vi.mock('../src/realtime', () => ({
  realtimeClient: () => ({
    onPush: (l: (p: { type: string; payload: unknown }) => void) => {
      socket.push = l;
      return () => undefined;
    },
    onReconnected: (l: () => void) => {
      socket.reconnect = l;
      return () => undefined;
    },
  }),
}));

import { ApiError } from '../src/api/client';
import { BookmarksStore } from '../src/bookmarks/store';
import { openTargetOf, placeOf, repliesText, shownBookmarks, shownCount, tabFrom } from '../src/bookmarks/model';
import { bookmarkToastText } from '../src/bookmarks/actions';
import { messageLocation } from '../src/shell/messageLink';
import { CORE_NAV, visibleNav } from '../src/shell/nav';
import { HEADER_TOOL_ORDER } from '../src/shell/headerMenu';

const ROOT = '0194f0a0-0000-7000-8000-000000000001';
const MSG = '0194f0a0-0000-7000-8000-000000000002';
const CH = '0194f0a0-0000-7000-8000-0000000000c1';
const BM = '0194f0a0-0000-7000-8000-0000000000b1';
const BM2 = '0194f0a0-0000-7000-8000-0000000000b2';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the client copy of the bookmarks', () => {
  let store: BookmarksStore;
  beforeEach(() => {
    vi.resetAllMocks();
    store = new BookmarksStore();
  });

  it('loads the keys once and answers has() and total', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 2, items: [{ id: BM, kind: 'thread', key: ROOT }, { id: BM2, kind: 'message', key: MSG }] });
    await store.load();
    await store.load();
    expect(api.fetchBookmarkKeys).toHaveBeenCalledTimes(1);
    expect(store.has('thread', ROOT)).toBe(true);
    expect(store.has('message', ROOT)).toBe(false);
    expect(store.snapshot().total).toBe(2);
  });

  it('a toggle shows at once, keeps the server id, and is put back when the server refuses', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 0, items: [] });
    await store.load();
    let resolve: (b: Partial<SavedBookmark>) => void = () => undefined;
    api.saveBookmark.mockReturnValue(new Promise((r) => (resolve = r)));
    const on = store.toggle({ kind: 'thread', rootMessageId: ROOT as never });
    expect(store.has('thread', ROOT)).toBe(true); // before the server answered
    expect(store.snapshot().total).toBe(1);
    resolve({ id: BM as never });
    expect(await on).toEqual({ on: true, ignored: false });
    expect(store.snapshot().ids.get(`thread:${ROOT}`)).toBe(BM);

    api.removeSavedBookmark.mockRejectedValue(new ApiError({ code: 'internal', message: 'boom', status: 500 } as never));
    await expect(store.toggle({ kind: 'thread', rootMessageId: ROOT as never })).rejects.toThrow();
    expect(store.has('thread', ROOT)).toBe(true); // rolled back

    api.saveBookmark.mockRejectedValue(new ApiError({ code: 'conflict', message: 'You have 500 bookmarks. Remove some first.', status: 409 }));
    await expect(store.toggle({ kind: 'message', messageId: MSG as never })).rejects.toThrow('500 bookmarks');
    expect(store.has('message', MSG)).toBe(false);
  });

  it('a removal the server no longer knows stays removed', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 1, items: [{ id: BM, kind: 'message', key: MSG }] });
    await store.load();
    api.removeSavedBookmark.mockRejectedValue(new ApiError({ code: 'not_found', message: 'gone', status: 404 }));
    expect(await store.toggle({ kind: 'message', messageId: MSG as never })).toEqual({ on: false, ignored: false });
    expect(store.snapshot().total).toBe(0);
  });

  it('follows the push from another tab, and reads the keys again after a reconnect', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 0, items: [] });
    await store.load();
    const changed = vi.fn();
    store.onChange(changed);
    socket.push?.({ type: 'bookmarks.changed', payload: { id: BM, kind: 'thread', key: ROOT, on: true } });
    expect(store.has('thread', ROOT)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    socket.push?.({ type: 'bookmarks.changed', payload: { id: BM, kind: 'thread', key: ROOT, on: false } });
    expect(store.snapshot().total).toBe(0);
    socket.push?.({ type: 'bookmarks.changed', payload: { nonsense: true } });
    socket.push?.({ type: 'other.push', payload: {} });
    expect(changed).toHaveBeenCalledTimes(2);
    socket.reconnect?.();
    await flush();
    expect(api.fetchBookmarkKeys).toHaveBeenCalledTimes(2);
  });

  it('a second press while a write is out is ignored and sends nothing; the slot is pending meanwhile', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 0, items: [] });
    await store.load();
    let resolve: (b: Partial<SavedBookmark>) => void = () => undefined;
    api.saveBookmark.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = store.toggle({ kind: 'thread', rootMessageId: ROOT as never });
    expect(store.isPending('thread', ROOT)).toBe(true);
    expect(await store.toggle({ kind: 'thread', rootMessageId: ROOT as never })).toEqual({ on: true, ignored: true });
    expect(api.removeSavedBookmark).not.toHaveBeenCalled();
    resolve({ id: BM as never });
    expect(await first).toEqual({ on: true, ignored: false });
    expect(store.isPending('thread', ROOT)).toBe(false);
    // now a press removes it
    api.removeSavedBookmark.mockResolvedValue({ removed: true });
    expect(await store.toggle({ kind: 'thread', rootMessageId: ROOT as never })).toEqual({ on: false, ignored: false });
  });

  it('the thread version moves only when a thread bookmark is confirmed or changes in another tab', async () => {
    api.fetchBookmarkKeys.mockResolvedValue({ total: 0, items: [] });
    await store.load();
    const v0 = store.snapshot().threadVersion;
    let resolve: (b: Partial<SavedBookmark>) => void = () => undefined;
    api.saveBookmark.mockReturnValue(new Promise((r) => (resolve = r)));
    const on = store.toggle({ kind: 'thread', rootMessageId: ROOT as never });
    expect(store.snapshot().threadVersion).toBe(v0); // optimistic: not yet
    // this tab's own push arrives before the answer: no news
    socket.push?.({ type: 'bookmarks.changed', payload: { id: BM, kind: 'thread', key: ROOT, on: true } });
    expect(store.snapshot().threadVersion).toBe(v0);
    resolve({ id: BM as never });
    await on;
    expect(store.snapshot().threadVersion).toBe(v0 + 1);
    // the same push after the answer changes nothing either
    socket.push?.({ type: 'bookmarks.changed', payload: { id: BM, kind: 'thread', key: ROOT, on: true } });
    expect(store.snapshot().threadVersion).toBe(v0 + 1);
    // a message bookmark never moves it
    api.saveBookmark.mockResolvedValue({ id: BM2 });
    await store.toggle({ kind: 'message', messageId: MSG as never });
    socket.push?.({ type: 'bookmarks.changed', payload: { id: BM2, kind: 'message', key: MSG, on: false } });
    expect(store.snapshot().threadVersion).toBe(v0 + 1);
    // another tab removes the thread bookmark: it moves
    socket.push?.({ type: 'bookmarks.changed', payload: { id: BM, kind: 'thread', key: ROOT, on: false } });
    expect(store.snapshot().threadVersion).toBe(v0 + 2);
  });

  it('a keys answer asked for before a person switch never fills the store; the next load asks for the new person', async () => {
    let resolveOld: (v: unknown) => void = () => undefined;
    api.fetchBookmarkKeys.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
    const old = store.load();
    store.reset();
    api.fetchBookmarkKeys.mockResolvedValueOnce({ total: 1, items: [{ id: BM2, kind: 'message', key: MSG }] });
    await store.load();
    resolveOld({ total: 1, items: [{ id: BM, kind: 'thread', key: ROOT }] });
    await old;
    expect(api.fetchBookmarkKeys).toHaveBeenCalledTimes(2);
    expect(store.has('thread', ROOT)).toBe(false);
    expect(store.has('message', MSG)).toBe(true);
    expect(store.snapshot().total).toBe(1);
  });

  it('a server without bookmarks (404), or a caller who has none (403), turns every control off', async () => {
    api.fetchBookmarkKeys.mockRejectedValue(new ApiError({ code: 'not_found', message: 'nope', status: 404 }));
    await store.load();
    expect(store.snapshot()).toMatchObject({ supported: false, loaded: true, total: 0 });
    await store.load(true);
    expect(api.fetchBookmarkKeys).toHaveBeenCalledTimes(1);
  });
});

describe('the sidebar entry and the contract of a showWhen entry', () => {
  it('Bookmarks is not a sidebar entry: its button sits at the top right, next to the bell (P37-05)', () => {
    expect(CORE_NAV.some((i) => i.id === 'bookmarks')).toBe(false);
    expect(visibleNav(CORE_NAV, { guest: false }, { 'bookmarks.total': 3 }).some((i) => i.id === 'bookmarks')).toBe(false);
  });

  it('showWhen works for any entry, and a guest still sees only what allows guests', () => {
    const items = [NavContribution.parse({ id: 'a', order: 1, label: 'a', kind: 'item', showWhen: 'x.count' }), NavContribution.parse({ id: 'b', order: 2, label: 'b', kind: 'item' })];
    expect(visibleNav(items, { guest: false }).map((i) => i.id)).toEqual(['b']);
    expect(visibleNav(items, { guest: false }, { 'x.count': 1 }).map((i) => i.id)).toEqual(['a', 'b']);
    // a guest keeps the channel groups
    expect(visibleNav(CORE_NAV, { guest: true }).map((i) => i.id)).toEqual(['channels']);
    expect(visibleNav(items, { guest: true }, { 'x.count': 1 })).toEqual([]);
    expect(NavContribution.safeParse({ id: 'a', order: 1, label: 'a', kind: 'item', showWhen: 'Bad Source' }).success).toBe(false);
  });
});

const place = { id: CH, name: 'dev', kind: 'channel' as const, teamId: null };
const bookmark = (over: Partial<SavedBookmark>): SavedBookmark => ({ id: BM, createdAt: '2026-11-24T10:00:00.000Z', target: { kind: 'message', messageId: MSG }, item: null, ...over }) as SavedBookmark;

describe('where a click on a bookmark leads', () => {
  it('a thread opens its channel with the thread on the right', () => {
    const b = bookmark({ target: { kind: 'thread', rootMessageId: ROOT } as never, item: { kind: 'thread', channel: place, title: 'Plan', rootAuthorName: 'Nadia', snippet: 'Plan', replyCount: 2, lastReplyAt: null } as never });
    const to = openTargetOf(b)!;
    expect(to).toMatchObject({ channelId: CH, messageId: ROOT, threadRootId: ROOT, channelName: 'dev' });
    const loc = messageLocation('eng', to);
    expect(loc.pathname).toBe('/t/eng/c/dev');
    expect(loc.search).toContain(`message=${ROOT}`);
    expect(decodeURIComponent(loc.search)).toContain(`thread:${ROOT}`);
  });

  it('a channel message opens the channel at it; a reply opens its thread on the right', () => {
    const plain = openTargetOf(bookmark({ item: { kind: 'message', channel: place, threadRootId: null, authorId: CH, authorName: 'Rafi', snippet: 'hi', messageCreatedAt: '2026-11-24T10:00:00.000Z' } as never }))!;
    expect(messageLocation('eng', plain)).toMatchObject({ pathname: '/t/eng/c/dev', search: `?message=${MSG}` });
    const reply = openTargetOf(bookmark({ item: { kind: 'message', channel: place, threadRootId: ROOT, authorId: CH, authorName: 'Rafi', snippet: 'hi', messageCreatedAt: '2026-11-24T10:00:00.000Z' } as never }))!;
    const loc = messageLocation('eng', reply);
    expect(loc.search).toContain(`message=${ROOT}`);
    expect(decodeURIComponent(loc.search)).toContain(`thread:${ROOT}`);
  });

  it('a direct message opens the conversation; a bot conversation opens the chat with the thread', () => {
    const dm = openTargetOf(bookmark({ item: { kind: 'message', channel: { ...place, kind: 'dm', name: '' }, threadRootId: null, authorId: CH, authorName: 'Rafi', snippet: 'hi', messageCreatedAt: '2026-11-24T10:00:00.000Z' } as never }))!;
    expect(messageLocation('eng', dm).pathname).toBe(`/t/eng/dm/${CH}`);
    const bot = openTargetOf(bookmark({ target: { kind: 'thread', rootMessageId: ROOT } as never, item: { kind: 'thread', channel: { ...place, kind: 'bot_conversation' }, title: '', rootAuthorName: 'Nadia', snippet: '', replyCount: 1, lastReplyAt: null } as never }))!;
    expect(messageLocation('eng', bot)).toMatchObject({ pathname: `/t/eng/chat/${CH}`, search: `?thread=${ROOT}` });
  });

  it('something no longer available leads nowhere', () => {
    expect(openTargetOf(bookmark({ item: null }))).toBeNull();
  });
});

describe('how a row reads', () => {
  it('names the place in words', () => {
    const m = (kind: string, threadRootId: string | null) => ({ kind: 'message', channel: { ...place, kind }, threadRootId, authorId: CH, authorName: 'x', snippet: '', messageCreatedAt: '' }) as never;
    expect(placeOf(m('channel', null))).toBe('# dev');
    expect(placeOf(m('channel', ROOT))).toBe('Thread in # dev');
    expect(placeOf(m('dm', null))).toBe('Direct message');
    expect(placeOf(m('bot_conversation', null))).toBe('Conversation with a bot');
    expect(repliesText(0)).toBe('No replies yet');
    expect(repliesText(1)).toBe('1 reply');
    expect(repliesText(4)).toBe('4 replies');
    expect(tabFrom('message')).toBe('message');
    expect(tabFrom('files')).toBe('thread');
    expect(tabFrom(null)).toBe('thread');
  });
});

describe('the Bookmarks page list and its counts', () => {
  const b = (id: string): SavedBookmark => bookmark({ id: id as never });
  const [A, B, C, N] = ['0194f0a0-0000-7000-8000-0000000000a1', '0194f0a0-0000-7000-8000-0000000000a2', '0194f0a0-0000-7000-8000-0000000000a3', '0194f0a0-0000-7000-8000-0000000000a4'];

  it('a removal waiting for the server, or confirmed after the answer was asked for, comes off the count once', () => {
    const pages = [[b(A), b(B)], [b(C)]];
    const asked = 1_000;
    expect(shownCount(3, asked, pages, new Map([[A, { confirmedAt: null }]]))).toBe(2);
    expect(shownCount(3, asked, pages, new Map([[C, { confirmedAt: 2_000 }]]))).toBe(2);
  });

  it('after a fresh answer that already left the removal out, it is not taken off again, wherever its row still is', () => {
    // C was confirmed at 1_500; the first page was read again at 2_000 (count 2, C is not in it) while the old second page still holds C
    expect(shownCount(2, 2_000, [[b(A), b(B)], [b(C)]], new Map([[C, { confirmedAt: 1_500 }]]))).toBe(2);
    expect(shownBookmarks([[b(A), b(B)], [b(C)]], new Map([[C, { confirmedAt: 1_500 }]]), new Map()).map((x) => x.id)).toEqual([A, B]);
  });

  it('Undo shows the new bookmark in the old place, once; removing it again takes it off', () => {
    const back = b(N);
    const swap = new Map([[B, back]]);
    expect(shownBookmarks([[b(A), b(B)], [b(C)]], new Map(), swap).map((x) => x.id)).toEqual([A, N, C]);
    // a fresh answer that already holds the new one: still once
    expect(shownBookmarks([[back, b(A)], [b(B), b(C)]], new Map(), swap).map((x) => x.id)).toEqual([N, A, C]);
    expect(shownCount(3, 1_000, [[b(A), b(B)], [b(C)]], new Map(), swap)).toBe(3);
    const gone = new Map([[N, { confirmedAt: null }]]);
    expect(shownBookmarks([[b(A), b(B)], [b(C)]], gone, swap).map((x) => x.id)).toEqual([A, C]);
    expect(shownCount(3, 1_000, [[b(A), b(B)], [b(C)]], gone, swap)).toBe(2);
  });

  it('one wording for every control', () => {
    expect(bookmarkToastText('thread', true)).toBe('Thread bookmarked');
    expect(bookmarkToastText('message', true)).toBe('Message bookmarked');
    expect(bookmarkToastText('message', false)).toBe('Bookmark removed');
  });
});

describe('the channel header says Links, not bookmarks', () => {
  it('the details menu item and the header tool', async () => {
    expect(HEADER_TOOL_ORDER).toContain('link');
    expect(HEADER_TOOL_ORDER).not.toContain('bookmark' as never);
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/channels/ChannelLinksBar.tsx', import.meta.url), 'utf8');
    expect(src).toContain("label: 'Add a link'");
    expect(src).toContain('aria-label="Channel links"');
    expect(src).not.toMatch(/Add a bookmark|Remove bookmark/);
  });
});
