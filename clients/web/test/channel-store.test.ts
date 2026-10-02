import { beforeEach, describe, expect, it } from 'vitest';
import type { ChannelMessage } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { buildListItems } from '../src/channels/listItems';
import { ChannelStore, channelKey, threadKey } from '../src/channels/store';
import { applyReaction, firstUnreadIndex, mergeItems, removeMessage } from '../src/channels/timeline';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CH = uuid(900);
const WS = uuid(901);
const ME = uuid(1);
const THEM = uuid(2);

function msg(n: number, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(100 + n),
    workspaceId: WS,
    channelId: CH,
    authorId: THEM,
    body: `message ${n}`,
    bodyPlain: `message ${n}`,
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    createdAt: `2026-09-07T08:${String(10 + n).padStart(2, '0')}:00.000Z`,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as ChannelMessage;
}

type Handler = (req: TransportRequest) => { status: number; body: unknown };
function serve(handler: Handler): TransportRequest[] {
  const seen: TransportRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    return handler(req);
  });
  return seen;
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('timeline helpers', () => {
  it('merge replaces by id and keeps id (time) order', () => {
    const merged = mergeItems([msg(1), msg(3)], [msg(2), msg(3, { body: 'edited' })]);
    expect(merged.map((m) => m.id)).toEqual([msg(1).id, msg(2).id, msg(3).id]);
    expect(merged[2]?.body).toBe('edited');
  });

  it('a deleted message with replies stays as a tombstone, one without goes', () => {
    const at = '2026-09-07T09:00:00.000Z';
    const items = [msg(1, { replyCount: 2 }), msg(2)];
    expect(removeMessage(items, msg(1).id, at)[0]).toMatchObject({ body: '[deleted]', deletedAt: at, bodyPlain: '' });
    expect(removeMessage(items, msg(2).id, at).map((m) => m.id)).toEqual([msg(1).id]);
  });

  it('reactions: counts follow the push, "mine" moves only for the reader', () => {
    const base = [{ emoji: '👍', count: 1, mine: false }];
    expect(applyReaction(base, { emoji: '👍', count: 2, added: true, byMe: false })).toEqual([{ emoji: '👍', count: 2, mine: false }]);
    expect(applyReaction(base, { emoji: '👍', count: 2, added: true, byMe: true })).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(applyReaction(base, { emoji: '🎉', count: 1, added: true, byMe: false })).toHaveLength(2);
    expect(applyReaction(base, { emoji: '👍', count: 0, added: false, byMe: false })).toEqual([]);
  });

  it('the unread divider goes before the first message after what was read that is not mine', () => {
    const items = [msg(1), msg(2, { authorId: ME as ChannelMessage['authorId'] }), msg(3), msg(4)];
    expect(firstUnreadIndex(items, msg(1).id, ME, true)).toBe(2);
    expect(firstUnreadIndex(items, msg(4).id, ME, true)).toBe(-1);
    expect(firstUnreadIndex(items, null, ME, true)).toBe(0);
    expect(firstUnreadIndex(items, null, ME, false)).toBe(-1); // never read and history not all loaded: no line
  });

  it('list items: day dividers, exactly one unread divider, pending last', () => {
    const items = [msg(1), msg(2), msg(3, { createdAt: '2026-09-08T08:00:00.000Z' })];
    const list = buildListItems(items, [{ localId: 'x', body: 'hi', attachments: [], status: 'sending', createdAt: '2026-09-08T09:00:00.000Z' }], {
      lastReadId: msg(1).id,
      selfActor: ME,
      allLoaded: true,
      readKnown: true,
      now: new Date('2026-09-08T12:00:00.000Z'),
    });
    expect(list.map((i) => i.kind)).toEqual(['day', 'message', 'unread', 'message', 'day', 'message', 'pending']);
    expect(list.filter((i) => i.kind === 'unread')).toHaveLength(1);
    expect(list.find((i) => i.kind === 'day' && i.key.endsWith('09-08'))).toMatchObject({ label: 'Today' });
  });
});

describe('channel store', () => {
  let store: ChannelStore;
  beforeEach(() => {
    store = new ChannelStore();
    store.setSelf(ME);
  });

  it('loads the newest page oldest-first and pages older ones by cursor', async () => {
    const all = [1, 2, 3, 4, 5].map((n) => msg(n));
    const seen = serve((req) => {
      const url = new URL(req.url, 'http://x');
      const before = url.searchParams.get('before');
      const older = all.filter((m) => !before || m.id < before).reverse();
      const limit = Number(url.searchParams.get('limit'));
      const items = older.slice(0, limit);
      return { status: 200, body: { items, nextCursor: older.length > limit ? (items.at(-1)?.id ?? null) : null } };
    });
    await store.loadChannel(CH);
    expect(store.get(channelKey(CH)).items.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(store.get(channelKey(CH)).cursor).toBeNull();
    expect(seen[0]?.url).toContain(`/api/channels/${CH}/messages?limit=50`);
  });

  it('a push adds the message once, even when our own POST answers too', async () => {
    serve(() => ({ status: 200, body: { items: [msg(1)], nextCursor: null } }));
    await store.loadChannel(CH);
    const incoming = msg(2, { authorId: ME as ChannelMessage['authorId'] });
    store.handlePush({ type: 'message.posted', id: 'x', payload: { channelId: CH, messageId: incoming.id, threadRootId: null, message: incoming } });
    await tick();
    store.applyPosted(incoming);
    expect(store.get(channelKey(CH)).items.map((m) => m.id)).toEqual([msg(1).id, incoming.id]);
  });

  it('optimistic send: shown at once, replaced by the real message; a failure stays as "failed" until retried', async () => {
    serve((req) => {
      if (req.method === 'GET') return { status: 200, body: { items: [], nextCursor: null } };
      return { status: 500, body: { error: { code: 'internal', message: 'down' } } };
    });
    await store.loadChannel(CH);
    await store.send(CH, null, 'hello');
    const [p] = store.get(channelKey(CH)).pending;
    expect(p).toMatchObject({ body: 'hello', status: 'failed' });

    const real = msg(7, { body: 'hello', authorId: ME as ChannelMessage['authorId'] });
    serve(() => ({ status: 201, body: { id: real.id, workspaceId: WS, channelId: CH, authorId: ME, body: 'hello', bodyPlain: 'hello', threadRootId: null, editedAt: null, deletedAt: null, meta: {}, createdAt: real.createdAt } }));
    await store.retry(CH, null, p?.localId ?? '');
    const tl = store.get(channelKey(CH));
    expect(tl.pending).toEqual([]);
    expect(tl.items.map((m) => m.body)).toEqual(['hello']);
  });

  it('a reply push counts once on its root and joins the open thread', async () => {
    const root = msg(1);
    serve((req) => {
      if (req.url.includes('threadRootId')) return { status: 200, body: { items: [], nextCursor: null } };
      if (req.url.startsWith(`/api/channels/${CH}/messages/${root.id}`)) return { status: 200, body: root };
      return { status: 200, body: { items: [root], nextCursor: null } };
    });
    await store.loadChannel(CH);
    await store.loadThread(root.id, CH); // no threads route in this fake: falls back to the channel API
    const reply = msg(2, { threadRootId: root.id as ChannelMessage['threadRootId'] });
    const push = { type: 'message.posted', id: 'x', payload: { channelId: CH, messageId: reply.id, threadRootId: root.id, message: reply } };
    store.handlePush(push);
    store.handlePush(push);
    await tick();
    expect(store.get(channelKey(CH)).items[0]?.replyCount).toBe(1);
    expect(store.get(threadKey(root.id)).items.map((m) => m.id)).toEqual([reply.id]);
  });

  it('reaction pushes update counts; edits and deletes land on the message', async () => {
    serve(() => ({ status: 200, body: { items: [msg(1), msg(2)], nextCursor: null } }));
    await store.loadChannel(CH);
    store.handlePush({ type: 'reaction.changed', id: 'r', payload: { channelId: CH, messageId: msg(1).id, actorId: THEM, emoji: '👍', added: true, count: 1 } });
    expect(store.get(channelKey(CH)).items[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    store.handlePush({ type: 'message.edited', id: 'e', payload: { channelId: CH, messageId: msg(2).id, threadRootId: null, message: msg(2, { body: 'changed', editedAt: '2026-09-07T10:00:00.000Z' }) } });
    expect(store.get(channelKey(CH)).items[1]).toMatchObject({ body: 'changed', editedAt: '2026-09-07T10:00:00.000Z' });
    store.handlePush({ type: 'message.deleted', id: 'd', payload: { channelId: CH, messageId: msg(2).id, threadRootId: null } });
    expect(store.get(channelKey(CH)).items.map((m) => m.id)).toEqual([msg(1).id]);
  });

  it('read-state pushes move the sidebar count; unknown pushes and junk payloads are ignored', () => {
    store.handlePush({ type: 'reading.state.changed', id: 'x', payload: { targetType: 'channel', targetId: CH, lastReadId: null, unreadCount: 3, followed: false, reason: 'posted' } });
    expect(store.snapshot().unread[CH]).toBe(3);
    store.handlePush({ type: 'reading.state.changed', id: 'x', payload: { targetType: 'channel', targetId: CH, lastReadId: msg(3).id, unreadCount: 0, followed: false, reason: 'read' } });
    expect(store.snapshot().unread[CH]).toBe(0);
    store.handlePush({ type: 'message.posted', id: 'x', payload: { nope: 1 } });
    store.handlePush({ type: 'something.else', id: 'x', payload: {} });
    expect(store.snapshot().unread[CH]).toBe(0);
  });

  it('forgets everything when the signed-in person changes', async () => {
    serve(() => ({ status: 200, body: { items: [msg(1)], nextCursor: null } }));
    await store.loadChannel(CH);
    store.seedUnread([{ id: CH, unread: 4 }]);
    store.reset();
    expect(store.get(channelKey(CH)).items).toEqual([]);
    expect(store.snapshot()).toEqual({ unread: {}, threadsUnread: 0 });
    expect(store.selfActor).toBeNull();
  });

  it('marking read is monotonic on the client too: an older position sends nothing', async () => {
    const seen = serve(() => ({ status: 200, body: { targetType: 'channel', targetId: CH, lastReadId: msg(5).id, unreadCount: 0, followed: false } }));
    await store.markRead('channel', CH, msg(5).id);
    await store.markRead('channel', CH, msg(4).id);
    expect(seen).toHaveLength(1);
  });
});
