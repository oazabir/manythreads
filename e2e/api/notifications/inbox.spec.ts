import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  GetNotificationPrefsResponse,
  GetNotificationSummaryResponse,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  type Notification,
} from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';

/**
 * The notifications inbox over HTTP (PLAN P3-09, spec e2e/channels/mentions-notifications.spec.ts at API level): Tariq mentions Priya, a
 * reply lands in a thread Priya follows, a direct message arrives; Priya's inbox lists them, the count follows, mark-read works, and the
 * settings round-trip. Everything happens in a new Marketing channel: a channel message is unread for the whole team, and another spec
 * expects Nadia (Engineering) to have nothing unread. Events are consumed in the background, so reads poll.
 */

const { omar, tariq, priya, nadia } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

test('mention, reply in a followed thread and a direct message reach the inbox; read state and settings work', async ({ request }) => {
  const created = await request.post('/api/teams/marketing/channels', { headers: as(omar), data: { name: `notify-${randomUUID().slice(0, 8)}` } });
  expect(created.status(), await created.text()).toBe(201);
  const channel = ((await created.json()) as { channel: { id: string } }).channel.id;
  const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
    const res = await request.post(`/api/channels/${channelId}/messages`, { headers: as(who), data: { channelId, body, threadRootId } });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const inbox = async (who: Persona, query = ''): Promise<Notification[]> => {
    const res = await request.get(`/api/notifications?limit=100${query}`, { headers: as(who) });
    expect(res.status(), await res.text()).toBe(200);
    return ListNotificationsResponse.parse(await res.json()).items;
  };
  const about = async (who: Persona, messageId: string): Promise<Notification[]> => (await inbox(who)).filter((n) => n.refId === messageId);

  // Mention: Priya only.
  const mention = await post(tariq, channel, 'Rollback is ready, **please look** @priya');
  await expect.poll(async () => (await about(priya, mention)).length, { timeout: 15_000 }).toBe(1);
  const [item] = await about(priya, mention);
  expect(item).toMatchObject({ kind: 'mention', channelId: channel, actorName: tariq.name, preview: 'Rollback is ready, please look @priya', readAt: null });
  expect(await about(tariq, mention)).toEqual([]);
  expect(await about(omar, mention)).toEqual([]);

  // Reply in a thread Priya follows.
  const root = await post(tariq, channel, 'Launch plan: thoughts?');
  expect((await request.post(`/api/threads/${root}/follow`, { headers: as(priya) })).status()).toBe(200);
  const reply = await post(omar, channel, 'Looks fine to me', root);
  await expect.poll(async () => (await about(priya, reply)).length, { timeout: 15_000 }).toBe(1);
  expect((await about(priya, reply))[0]).toMatchObject({ kind: 'reply', threadRootId: root });
  expect(await about(omar, reply)).toEqual([]);

  // Direct message.
  const opened = await request.post('/api/dms', { headers: as(tariq), data: { personIds: [priya.personId] } });
  expect(opened.status(), await opened.text()).toBeLessThan(300);
  const dm = ((await opened.json()) as { dm: { channel: { id: string } } }).dm.channel.id;
  const hello = await post(tariq, dm, 'Check the rota?');
  await expect.poll(async () => (await about(priya, hello)).length, { timeout: 15_000 }).toBe(1);
  expect((await about(priya, hello))[0]).toMatchObject({ kind: 'dm', channelName: null, channelKind: 'dm' });

  // Count, filter, mark read.
  const summary = async (): Promise<number> =>
    GetNotificationSummaryResponse.parse(await (await request.get('/api/notifications/summary', { headers: as(priya) })).json()).unreadCount;
  const unreadBefore = await summary();
  expect(unreadBefore).toBeGreaterThanOrEqual(3);
  expect((await inbox(priya, '&unread=true')).length).toBe(unreadBefore);
  const marked = await request.post('/api/notifications/mark-read', { headers: as(priya), data: { ids: [item!.id] } });
  expect(MarkNotificationsReadResponse.parse(await marked.json())).toEqual({ updated: 1, unreadCount: unreadBefore - 1 });
  const foreign = await request.post('/api/notifications/mark-read', { headers: as(nadia), data: { ids: [(await about(priya, reply))[0]!.id] } });
  expect(MarkNotificationsReadResponse.parse(await foreign.json()).updated).toBe(0);
  expect(await summary()).toBe(unreadBefore - 1); // someone else's id changes nothing
  const all = await request.post('/api/notifications/mark-read', { headers: as(priya), data: { all: true } });
  expect(MarkNotificationsReadResponse.parse(await all.json()).unreadCount).toBe(0);
  expect(await summary()).toBe(0);

  // Settings: defaults, a change, and it applies.
  const prefs = GetNotificationPrefsResponse.parse(await (await request.get('/api/notifications/prefs', { headers: as(priya) })).json());
  expect(prefs.mention.inApp).toBe(true);
  const muted = await request.put('/api/notifications/prefs', {
    headers: as(priya),
    data: { ...prefs, mutedChannels: [channel], mention: { inApp: true, browser: true } },
  });
  expect(muted.status(), await muted.text()).toBe(200);
  const quiet = await post(tariq, channel, 'muted for Priya @priya');
  const control = await post(tariq, channel, 'control for Omar @omar');
  await expect.poll(async () => (await about(omar, control)).length, { timeout: 15_000 }).toBe(1);
  expect(await about(priya, quiet)).toEqual([]);
  const restore = await request.put('/api/notifications/prefs', { headers: as(priya), data: prefs });
  expect(restore.status()).toBe(200);

  // Not signed in, and a malformed request.
  expect((await request.get('/api/notifications')).status()).toBe(401);
  expect((await request.post('/api/notifications/mark-read', { headers: as(priya), data: { ids: ['x'] } })).status()).toBe(400);
});
