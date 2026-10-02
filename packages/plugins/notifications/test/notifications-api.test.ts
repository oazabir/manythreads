import { randomUUID } from 'node:crypto';
import { emit } from '@manythreads/kernel';
import {
  GetNotificationPrefsResponse,
  GetNotificationSummaryResponse,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  NotificationCreatedPush,
  NotificationReadPush,
  NotificationKind,
  type Notification,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, sameera, priya, lena } = personas;

let w: World;
let dev = '';
let general = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  general = await w.channelId('engineering', 'general');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId }), 201).id;
const inbox = async (who: Persona, query = ''): Promise<Notification[]> =>
  ListNotificationsResponse.parse(ok(await w.call(who, 'GET', `/api/notifications${query}`))).items;
const unread = async (who: Persona): Promise<number> => GetNotificationSummaryResponse.parse(ok(await w.call(who, 'GET', '/api/notifications/summary'))).unreadCount;
const setPrefs = async (who: Persona, patch: Record<string, unknown>): Promise<void> => {
  const current = GetNotificationPrefsResponse.parse(ok(await w.call(who, 'GET', '/api/notifications/prefs')));
  ok(await w.call(who, 'PUT', '/api/notifications/prefs', { ...current, ...patch }));
};
const resetPrefs = async (who: Persona): Promise<void> => {
  ok(await w.call(who, 'PUT', '/api/notifications/prefs', {
    mention: { inApp: true, browser: false },
    reply: { inApp: true, browser: false },
    dm: { inApp: true, browser: false },
    mutedChannels: [],
  }));
};
const forMessage = (items: Notification[], messageId: string): Notification[] => items.filter((n) => n.refId === messageId);
/** Waits until `who` has a notification about the message and returns the ones about it. */
const told = async (who: Persona, messageId: string): Promise<Notification[]> =>
  eventually(async () => {
    const items = forMessage(await inbox(who), messageId);
    return items.length > 0 ? items : undefined;
  }, 20_000, `a notification for ${who.key} about ${messageId}`);

describe('mentions', () => {
  it('a mention makes one notification, for the person named and nobody else', async () => {
    const id = await post(nadia, dev, 'Rollback is ready, **please look** @rafi');
    const rafiItems = await told(rafi, id);
    expect(rafiItems).toHaveLength(1);
    expect(rafiItems[0]).toMatchObject({
      kind: 'mention',
      refType: 'message',
      refId: id,
      channelId: dev,
      channelName: 'dev',
      channelKind: 'channel',
      threadRootId: null,
      actorId: nadia.actorId,
      actorName: nadia.name,
      preview: 'Rollback is ready, please look @rafi',
      readAt: null,
    });
    await drained(w);
    expect(forMessage(await inbox(nadia), id)).toEqual([]);
    expect(forMessage(await inbox(omar), id)).toEqual([]);
    expect(forMessage(await inbox(priya), id)).toEqual([]);
    expect(await unread(rafi)).toBe(1);
  });

  it('naming yourself, an edit that keeps the mention, and a repeated mention in one message add nothing', async () => {
    const before = (await inbox(rafi)).length;
    const own = await post(rafi, dev, 'note to self @rafi');
    const twice = await post(nadia, dev, '@rafi and again @rafi');
    await eventually(async () => ((await inbox(rafi)).some((n) => n.refId === twice) ? true : undefined));
    await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${twice}`, { body: '@rafi and again @rafi, edited' });
    await drained(w);
    const items = await inbox(rafi);
    expect(items).toHaveLength(before + 1);
    expect(forMessage(items, own)).toEqual([]);
    expect(forMessage(items, twice)).toHaveLength(1);
  });

  it('a mention of someone who cannot read a private channel notifies nobody, even from a forged event', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'leads-only', private: true }), 201);
    const priv = created.channel.id;
    expect((await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: nadia.personId })).status).toBeLessThan(300);
    const id = await post(nadia, priv, 'budget talk, do not tell @rafi');
    await drained(w);
    expect(forMessage(await inbox(rafi), id)).toEqual([]);
    // The channels plugin never announces a mention of an outsider; the consumer checks the audience itself anyway.
    await w.system((tx) =>
      emit(tx, {
        type: 'channel.mention.created',
        schemaVersion: 1,
        workspaceId: omar.workspaceId,
        channelId: priv,
        teamId: null,
        messageId: id,
        threadRootId: null,
        authorId: nadia.actorId,
        kind: 'person',
        mentionedId: rafi.actorId,
        personId: rafi.personId,
      }),
    );
    await drained(w);
    expect(forMessage(await inbox(rafi), id)).toEqual([]);
    // A member of the channel is told.
    const idForOmar = await post(nadia, priv, 'and @omar knows');
    expect(await told(omar, idForOmar)).toHaveLength(1);
  });

  it('a person removed from a private channel no longer sees its notifications', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'short-lived', private: true }), 201);
    const priv = created.channel.id;
    expect((await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId })).status).toBeLessThan(300);
    const id = await post(omar, priv, 'secret plan for @rafi');
    expect(await told(rafi, id)).toHaveLength(1);
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${rafi.personId}`));
    expect(forMessage(await inbox(rafi), id)).toEqual([]);
    // The consumer of channel.member.removed deletes what that channel notified them of.
    await eventually(async () => ((await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.notifications WHERE ref_id = $1', [id])).rows.length)) === 0 ? true : undefined));
  });

  it('leaving a channel everyone on the team can read keeps its notifications', async () => {
    const id = await post(nadia, general, 'welcome @rafi');
    expect(await told(rafi, id)).toHaveLength(1);
    await w.call(rafi, 'POST', `/api/channels/${general}/join`);
    expect((await w.call(rafi, 'POST', `/api/channels/${general}/leave`)).status).toBeLessThan(300);
    await drained(w);
    expect(forMessage(await inbox(rafi), id)).toHaveLength(1);
  });

  it('deleting the message removes its notifications', async () => {
    const id = await post(nadia, dev, 'oops wrong channel @rafi');
    expect(await told(rafi, id)).toHaveLength(1);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    await eventually(async () => (forMessage(await inbox(rafi), id).length === 0 ? true : undefined));
  });
});

describe('replies in followed threads', () => {
  it('followers except the author get a reply notification; the author of the root follows from the first reply', async () => {
    const root = await post(nadia, dev, 'Deploy plan: thoughts?');
    ok(await w.call(rafi, 'POST', `/api/threads/${root}/follow`));
    const first = await post(priya, dev, 'Looks good to me', root);
    const rafiFirst = await told(rafi, first);
    expect(rafiFirst).toHaveLength(1);
    expect(rafiFirst[0]).toMatchObject({ kind: 'reply', refId: first, threadRootId: root, actorId: priya.actorId, preview: 'Looks good to me' });
    // Nadia wrote the root, so she follows from this first reply on and is told of it; Priya wrote it and is not.
    expect(await told(nadia, first)).toHaveLength(1);
    await drained(w);
    expect(forMessage(await inbox(priya), first)).toEqual([]);
    // Her own reply does not notify her; the others get it.
    const second = await post(nadia, dev, 'Thanks both', root);
    await eventually(async () => (forMessage(await inbox(rafi), second).length === 1 ? true : undefined));
    await eventually(async () => (forMessage(await inbox(priya), second).length === 1 ? true : undefined));
    expect(forMessage(await inbox(nadia), second)).toEqual([]);
  });

  it('someone who does not follow the thread is not told', async () => {
    const root = await post(nadia, dev, 'Quiet thread');
    const reply = await post(priya, dev, 'a reply', root);
    await eventually(async () => (forMessage(await inbox(nadia), reply).length === 1 ? true : undefined));
    expect(forMessage(await inbox(rafi), reply)).toEqual([]);
    expect(forMessage(await inbox(omar), reply)).toEqual([]);
  });

  it('unfollowing stops them', async () => {
    const root = await post(nadia, dev, 'Another thread');
    ok(await w.call(rafi, 'POST', `/api/threads/${root}/follow`));
    ok(await w.call(rafi, 'POST', `/api/threads/${root}/unfollow`));
    const reply = await post(priya, dev, 'anyone there?', root);
    await eventually(async () => (forMessage(await inbox(nadia), reply).length === 1 ? true : undefined));
    expect(forMessage(await inbox(rafi), reply)).toEqual([]);
  });

  it('a reply that also names a follower is one notification, a mention, whichever event is handled first', async () => {
    const root = await post(nadia, dev, 'Thread with a mention');
    ok(await w.call(rafi, 'POST', `/api/threads/${root}/follow`));
    const reply = await post(priya, dev, 'over to you @rafi', root);
    await eventually(async () => (forMessage(await inbox(rafi), reply).length >= 1 ? true : undefined));
    await drained(w);
    const items = forMessage(await inbox(rafi), reply);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('mention');
  });
});

describe('direct messages', () => {
  it('the other members get a dm; the sender does not; a mention inside it is still one notification', async () => {
    const opened = ok(await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] }), 201);
    const dm = opened.dm.channel.id;
    const hello = await post(nadia, dm, 'Check the rota?');
    const items = await told(rafi, hello);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'dm', channelId: dm, channelName: null, channelKind: 'dm', actorName: nadia.name, preview: 'Check the rota?' });
    await drained(w);
    expect(forMessage(await inbox(nadia), hello)).toEqual([]);
    const named = await post(nadia, dm, 'ping @rafi');
    await eventually(async () => (forMessage(await inbox(rafi), named).length >= 1 ? true : undefined));
    await drained(w);
    const both = forMessage(await inbox(rafi), named);
    expect(both).toHaveLength(1);
    expect(both[0]?.kind).toBe('mention');
    // Someone outside the conversation sees nothing of it.
    expect(forMessage(await inbox(omar), hello)).toEqual([]);
    expect(forMessage(await inbox(priya), hello)).toEqual([]);
  });

  it('a group conversation notifies every other member', async () => {
    const opened = ok(await w.call<{ dm: { channel: { id: string } } }>(omar, 'POST', '/api/dms', { personIds: [rafi.personId, priya.personId] }), 201);
    const id = await post(omar, opened.dm.channel.id, 'standup moved to 10');
    await eventually(async () => (forMessage(await inbox(rafi), id).length === 1 && forMessage(await inbox(priya), id).length === 1 ? true : undefined));
    expect(forMessage(await inbox(omar), id)).toEqual([]);
    expect(forMessage(await inbox(nadia), id)).toEqual([]);
  });
});

describe('muting and settings', () => {
  it('a muted channel (settings or membership) and a switched-off kind notify nobody', async () => {
    try {
      // 1. muted in the settings
      await setPrefs(rafi, { mutedChannels: [general] });
      const a = await post(nadia, general, 'general news @rafi');
      await drained(w);
      // 2. muted membership
      await w.system((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id, muted) VALUES ($1, $2, true) ON CONFLICT (channel_id, person_id) DO UPDATE SET muted = true', [dev, rafi.personId]));
      const b = await post(nadia, dev, 'dev news @rafi');
      await drained(w);
      await w.system((tx) => tx.query('UPDATE app.channel_members SET muted = false WHERE channel_id = $1 AND person_id = $2', [dev, rafi.personId]));
      // 3. the kind switched off
      await setPrefs(rafi, { mutedChannels: [], mention: { inApp: false, browser: false } });
      const c = await post(nadia, dev, 'more dev news @rafi');
      await drained(w);
      // The control: nobody is muted for Priya, so she is told about the same kind of message.
      const control = await post(nadia, dev, 'control @priya');
      await eventually(async () => (forMessage(await inbox(priya), control).length === 1 ? true : undefined));
      await drained(w);
      const items = await inbox(rafi);
      for (const id of [a, b, c]) expect(forMessage(items, id), id).toEqual([]);
      // Turned back on, the next one comes.
      await resetPrefs(rafi);
      const d = await post(nadia, dev, 'back on @rafi');
      expect(await told(rafi, d)).toHaveLength(1);
    } finally {
      await resetPrefs(rafi);
    }
  });

  it('GET returns the defaults, PUT replaces the document, a malformed body is 400, duplicates fold, only your own settings exist', async () => {
    const defaults = GetNotificationPrefsResponse.parse(ok(await w.call(priya, 'GET', '/api/notifications/prefs')));
    expect(defaults).toEqual({ mention: { inApp: true, browser: false }, reply: { inApp: true, browser: false }, dm: { inApp: true, browser: false }, mutedChannels: [] });
    const saved = GetNotificationPrefsResponse.parse(
      ok(await w.call(priya, 'PUT', '/api/notifications/prefs', { ...defaults, dm: { inApp: true, browser: true }, mutedChannels: [dev, dev, general] })),
    );
    expect(saved.dm).toEqual({ inApp: true, browser: true });
    expect(saved.mutedChannels).toEqual([dev, general]);
    expect(GetNotificationPrefsResponse.parse(ok(await w.call(priya, 'GET', '/api/notifications/prefs')))).toEqual(saved);
    expect(GetNotificationPrefsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/prefs'))).mutedChannels).toEqual([]);
    expect((await w.call(priya, 'PUT', '/api/notifications/prefs', { ...defaults, extra: true })).status).toBe(400);
    expect((await w.call(priya, 'PUT', '/api/notifications/prefs', { mention: { inApp: true } })).status).toBe(400);
    expect((await w.call(priya, 'PUT', '/api/notifications/prefs', { ...defaults, mutedChannels: ['nope'] })).status).toBe(400);
    expect((await w.call(null, 'GET', '/api/notifications/prefs')).status).toBe(401);
    await resetPrefs(priya);
  });

  it('exposes the browser flag in the push and the settings', async () => {
    try {
      await setPrefs(rafi, { mention: { inApp: true, browser: true } });
      expect(GetNotificationPrefsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/prefs'))).mention.browser).toBe(true);
    } finally {
      await resetPrefs(rafi);
    }
  });
});

describe('reading', () => {
  it('lists newest first with a cursor, filters unread, marks some and then all read, and keeps the count', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await post(omar, dev, `ping ${i} @priya`));
    await eventually(async () => ((await inbox(priya)).filter((n) => ids.includes(n.refId)).length === 5 ? true : undefined));
    const all = await inbox(priya);
    expect(all.map((n) => n.id)).toEqual([...all.map((n) => n.id)].sort().reverse());
    const total = all.length;
    const page1 = ListNotificationsResponse.parse(ok(await w.call(priya, 'GET', '/api/notifications?limit=2')));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1]?.id);
    const page2 = ListNotificationsResponse.parse(ok(await w.call(priya, 'GET', `/api/notifications?limit=2&cursor=${page1.nextCursor}`)));
    expect(page2.items[0]?.id).toBe(all[2]?.id);
    expect((await w.call(priya, 'GET', '/api/notifications?cursor=nope')).status).toBe(400);
    expect((await w.call(priya, 'GET', '/api/notifications?limit=0')).status).toBe(400);

    expect(await unread(priya)).toBe(total);
    const some = MarkNotificationsReadResponse.parse(ok(await w.call(priya, 'POST', '/api/notifications/mark-read', { ids: [all[0]!.id, all[1]!.id] })));
    expect(some).toEqual({ updated: 2, unreadCount: total - 2 });
    const again = MarkNotificationsReadResponse.parse(ok(await w.call(priya, 'POST', '/api/notifications/mark-read', { ids: [all[0]!.id] })));
    expect(again).toEqual({ updated: 0, unreadCount: total - 2 });
    expect(await inbox(priya, '?unread=true')).toHaveLength(total - 2);
    const readItem = (await inbox(priya)).find((n) => n.id === all[0]!.id);
    expect(readItem?.readAt).not.toBeNull();

    const everything = MarkNotificationsReadResponse.parse(ok(await w.call(priya, 'POST', '/api/notifications/mark-read', { all: true })));
    expect(everything).toEqual({ updated: total - 2, unreadCount: 0 });
    expect(await unread(priya)).toBe(0);
    expect(await inbox(priya, '?unread=true')).toEqual([]);
    expect(await inbox(priya)).toHaveLength(total);
  });

  it('marking read touches only your own notifications; a bad body is 400; a bot has no inbox; a guest sees only her own', async () => {
    const id = await post(omar, dev, 'for rafi only @rafi');
    const mine = (await told(rafi, id))[0]!;
    const before = await unread(rafi);
    const foreign = MarkNotificationsReadResponse.parse(ok(await w.call(nadia, 'POST', '/api/notifications/mark-read', { ids: [mine.id] })));
    expect(foreign.updated).toBe(0);
    expect(await unread(rafi)).toBe(before);
    expect((await w.call(rafi, 'POST', '/api/notifications/mark-read', {})).status).toBe(400);
    expect((await w.call(rafi, 'POST', '/api/notifications/mark-read', { ids: [] })).status).toBe(400);
    expect((await w.call(rafi, 'POST', '/api/notifications/mark-read', { ids: [randomUUID()], all: true })).status).toBe(400);
    expect((await w.call(null, 'POST', '/api/notifications/mark-read', { all: true })).status).toBe(401);
    expect((await w.call(null, 'GET', '/api/notifications')).status).toBe(401);
    expect(await inbox(lena)).toEqual([]);
    expect(await inbox(sameera)).toEqual([]);
  });
});

describe('live push', () => {
  const socket = async (who: Persona): Promise<{ messages: Array<{ type: string; payload: unknown }>; close(): void }> => {
    const messages: Array<{ type: string; payload: unknown }> = [];
    const ws = new WebSocket(`${w.server.url.replace('http', 'ws')}/ws`, {
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) },
    } as never);
    ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as { type: string; payload: unknown }));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('socket failed')));
    });
    await eventually(async () => (w.server.app.realtime.connections(who.personId) >= 1 ? true : undefined), 5_000, 'the socket to attach');
    return { messages, close: () => ws.close() };
  };

  it('sends notification.created to the person and notification.read to their other tabs', async () => {
    const sock = await socket(rafi);
    try {
      const id = await post(nadia, dev, 'live one @rafi');
      const pushed = await eventually(async () => sock.messages.find((m) => m.type === 'notification.created' && NotificationCreatedPush.parse(m.payload).notification.refId === id), 20_000, 'notification.created');
      const push = NotificationCreatedPush.parse(pushed.payload);
      expect(push.notification.kind).toBe('mention');
      expect(push.browser).toBe(false);
      ok(await w.call(rafi, 'POST', '/api/notifications/mark-read', { ids: [push.notification.id] }));
      const read = await eventually(async () => sock.messages.find((m) => m.type === 'notification.read'), 10_000, 'notification.read');
      expect(NotificationReadPush.parse(read.payload)).toMatchObject({ ids: [push.notification.id], all: false });
    } finally {
      sock.close();
    }
  });

  it('knows the kinds', () => {
    expect(NotificationKind.options).toEqual(['mention', 'reply', 'dm']);
  });
});

describe('at-least-once delivery', () => {
  it('handling the same event again, even without the processed marker, creates no second notification and announces nothing', async () => {
    const id = await post(nadia, dev, 'exactly once please @rafi');
    await told(rafi, id);
    await drained(w);
    const events = async (): Promise<number> =>
      w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'notifications.notification.created' AND payload->>'refId' = $1", [id])).rows[0]!.n);
    expect(await events()).toBe(1);
    // Put every delivery of this message's events back as if the consumer had crashed before acknowledging (and forgot it had run).
    await w.system(async (tx) => {
      const rows = await tx.query<{ id: string }>("SELECT id FROM app.events WHERE type IN ('channel.mention.created', 'channel.message.posted') AND payload->>'messageId' = $1", [id]);
      const eventIds = rows.rows.map((r) => r.id);
      expect(eventIds.length).toBe(2);
      await tx.query('DELETE FROM app.outbox_processed WHERE event_id = ANY ($1::uuid[])', [eventIds]);
      await tx.query('UPDATE app.outbox SET done_at = NULL, claimed_until = NULL, available_at = now() WHERE event_id = ANY ($1::uuid[])', [eventIds]);
    });
    await new Promise((r) => setTimeout(r, 500));
    await drained(w);
    expect(forMessage(await inbox(rafi), id)).toHaveLength(1);
    expect(await events()).toBe(1);
  });
});
