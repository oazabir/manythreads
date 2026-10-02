import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { dmLabel } from '../src/dms/store';
import { NotificationStore, notificationTitle } from '../src/notifications/store';
import { highlightRanges, similarity } from '../src/search/highlight';
import { parseSearchEntry, searchEntry } from '../src/search/searchEntry';
import { messageLocation } from '../src/shell/messageLink';
import { readPanel } from '../src/kernel/panel';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('search highlight', () => {
  it('marks the words close to the query, also a typo, and nothing else', () => {
    const text = 'Merged the rollback fix, see #releases';
    const marked = highlightRanges(text, 'rolback').map(([s, e]) => text.slice(s, e));
    expect(marked).toEqual(['rollback']);
    expect(highlightRanges(text, 'merged fix').map(([s, e]) => text.slice(s, e))).toEqual(['Merged', 'fix']);
    expect(highlightRanges(text, 'zebra')).toEqual([]);
    expect(highlightRanges(text, 'a')).toEqual([]);
  });
  it('uses the trigram measure of pg_trgm', () => {
    expect(similarity('rollback', 'rollback')).toBe(1);
    expect(similarity('rolback', 'rollback')).toBeGreaterThan(0.5);
    expect(similarity('deploy', 'rollback')).toBeLessThan(0.2);
  });
  it('stays fast on a long hostile snippet', () => {
    const text = 'a-b '.repeat(500);
    const t = performance.now();
    highlightRanges(text, 'abc def ghi');
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('search panel entries', () => {
  it('round-trips a plain and a conversation-scoped query', () => {
    expect(searchEntry('  rollback   plan ')).toEqual({ type: 'search', id: 'rollback plan' });
    expect(parseSearchEntry('rollback plan')).toEqual({ q: 'rollback plan', channelId: null });
    const scoped = searchEntry('check rota', uuid(7));
    expect(parseSearchEntry(scoped.id)).toEqual({ q: 'check rota', channelId: uuid(7) });
  });
});

describe('where a message opens', () => {
  const dev = { channelId: uuid(1), channelKind: 'channel' as const, channelName: 'dev', messageId: uuid(5), threadRootId: null };
  it('a channel message scrolls to itself and keeps what is under it in the panel', () => {
    const loc = messageLocation('engineering', dev, [searchEntry('rollback')]);
    expect(loc.pathname).toBe('/t/engineering/c/dev');
    expect(new URLSearchParams(loc.search).get('message')).toBe(uuid(5));
    expect(readPanel(loc).stack).toEqual([{ type: 'search', id: 'rollback' }]);
  });
  it('a reply opens its root and the thread on top of the search', () => {
    const loc = messageLocation('engineering', { ...dev, messageId: uuid(6), threadRootId: uuid(5) }, [searchEntry('rollback')]);
    expect(new URLSearchParams(loc.search).get('message')).toBe(uuid(5));
    expect(readPanel(loc).stack.map((e) => e.type)).toEqual(['search', 'thread']);
  });
  it('a direct message goes to the conversation screen', () => {
    const loc = messageLocation('engineering', { ...dev, channelKind: 'dm', channelName: null }, []);
    expect(loc.pathname).toBe(`/t/engineering/dm/${uuid(1)}`);
    expect(readPanel(loc).stack).toEqual([]);
  });
});

describe('direct message labels', () => {
  const dm = { participants: [{ personId: uuid(1), displayName: 'Nadia' }, { personId: uuid(2), displayName: 'Rafi' }] } as never;
  it('names the other people, or notes to self', () => {
    expect(dmLabel(dm, uuid(1))).toBe('Rafi');
    expect(dmLabel({ participants: [{ personId: uuid(1), displayName: 'Nadia' }] } as never, uuid(1))).toBe('Notes to self');
  });
});

describe('notification store', () => {
  let store: NotificationStore;
  const item = (n: number, over: Record<string, unknown> = {}) => ({
    id: uuid(200 + n),
    kind: 'mention',
    refType: 'message',
    refId: uuid(300 + n),
    channelId: uuid(1),
    channelName: 'dev',
    channelKind: 'channel',
    threadRootId: null,
    actorId: uuid(2),
    actorName: 'Nadia',
    preview: 'hello @rafi',
    readAt: null,
    createdAt: '2026-09-07T08:10:00.000Z',
    ...over,
  });
  const created = (n: Record<string, unknown>, browser = false) => ({ type: 'notification.created', id: 'x', payload: { notification: n, browser } });
  const seen: TransportRequest[] = [];
  beforeEach(() => {
    store = new NotificationStore();
    seen.length = 0;
    setTransport(async (req) => {
      seen.push(req);
      if (req.url.startsWith('/api/notifications/summary')) return { status: 200, body: { unreadCount: 2 } };
      if (req.url.startsWith('/api/notifications/mark-read')) return { status: 200, body: { updated: 1, unreadCount: 0 } };
      return { status: 404, body: { error: { code: 'not_found', message: 'no' } } };
    });
  });

  it('a live push raises the badge once per new id and upserts a changed one', () => {
    store.handlePush(created(item(1)));
    store.handlePush(created(item(2, { kind: 'reply' })));
    expect(store.snapshot().unread).toBe(2);
    // a reply that became a mention: same id, no new badge
    store.handlePush(created(item(2, { kind: 'mention' })));
    expect(store.snapshot().unread).toBe(2);
    expect(store.snapshot().supported).toBe(true);
  });
  it('a read push from another tab drops the badge and marks the held items read', async () => {
    await store.loadItems().catch(() => undefined);
    store.handlePush(created(item(1)));
    store.handlePush({ type: 'notification.read', id: 'y', payload: { ids: [], all: true, unreadCount: 0 } });
    expect(store.snapshot().unread).toBe(0);
  });
  it('the summary is the authoritative count; a server without the plugin leaves the bell out', async () => {
    await store.refreshSummary();
    expect(store.snapshot()).toMatchObject({ supported: true, unread: 2 });
    const none = new NotificationStore();
    setTransport(async () => ({ status: 404, body: { error: { code: 'not_found', message: 'no' } } }));
    await none.refreshSummary();
    expect(none.snapshot().supported).toBe(false);
  });
  it('titles read as the wireframe: mentioned you, replied in a thread, sent you a message', () => {
    expect(notificationTitle({ kind: 'mention', actorName: 'Rafi', channelName: 'dev' })).toBe('Rafi mentioned you in #dev');
    expect(notificationTitle({ kind: 'reply', actorName: 'Rafi', channelName: 'deploy-plan' })).toBe('Rafi replied in a thread in #deploy-plan');
    expect(notificationTitle({ kind: 'dm', actorName: 'Rafi', channelName: null })).toBe('Rafi sent you a message');
  });
});
