import { ListNotificationsResponse, type Notification, type NotificationLevel } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, priya } = personas;

// P14-03: mentioning a role group (`@pager`, from the team's `role:pager` tag) tells each holder as a mention does: one notification each, the author is
// never told, a person named twice is told once, and each person's own level for the channel still decides whether it interrupts them.

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  for (const who of [nadia, rafi, priya]) await w.call(who, 'POST', `/api/channels/${dev}/join`);
  ok(await w.call(omar, 'POST', '/api/teams/engineering/tags', { name: 'role:pager' }), 201);
  for (const who of [rafi, priya, omar]) ok(await w.call(omar, 'PUT', `/api/teams/engineering/members/${who.personId}/tags/${encodeURIComponent('role:pager')}`));
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const about = async (who: Persona, messageId: string): Promise<Notification[]> =>
  ListNotificationsResponse.parse(ok(await w.call(who, 'GET', '/api/notifications'))).items.filter((n) => n.refId === messageId);
const told = (who: Persona, messageId: string): Promise<Notification[]> =>
  eventually(async () => {
    const items = await about(who, messageId);
    return items.length > 0 ? items : undefined;
  }, 20_000, `${who.key} to be told about ${messageId}`);
const notTold = async (who: Persona, messageId: string): Promise<void> => {
  await drained(w);
  expect(await about(who, messageId), `${who.key} should not be told`).toEqual([]);
};
const setLevel = async (who: Persona, channelId: string, level: NotificationLevel | null) => ok(await w.call(who, 'PUT', `/api/notifications/levels/${channelId}`, { level }));

describe('mentioning a role group', () => {
  it('tells each holder once as a mention, and never the author', async () => {
    const id = await post(nadia, dev, 'Deploy is stuck, @pager please look');
    for (const who of [rafi, priya, omar]) {
      const items = await told(who, id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'mention', refType: 'message', refId: id, channelId: dev, actorName: nadia.name });
    }
    await notTold(nadia, id);
  });

  it('a holder who is also named directly gets one notification', async () => {
    const id = await post(nadia, dev, '@rafi and the rest of @pager');
    await told(rafi, id);
    await drained(w);
    expect(await about(rafi, id)).toHaveLength(1);
  });

  it('the author who holds the tag is not told about their own message', async () => {
    const id = await post(omar, dev, 'I am on the @pager myself, but rafi and priya please check');
    await told(rafi, id);
    await told(priya, id);
    await notTold(omar, id);
  });

  it('a holder whose level for the channel is "nothing" is not interrupted; the others are', async () => {
    await setLevel(rafi, dev, 'nothing');
    const id = await post(nadia, dev, 'again @pager');
    await told(priya, id);
    await notTold(rafi, id);
    await setLevel(rafi, dev, null);
  });

  it('a person who is not a holder, and a holder who cannot read a private channel, are not told', async () => {
    const priv = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'pager-private', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId }));
    const id = await post(omar, priv, '@pager only the ones in here');
    await told(rafi, id);
    await notTold(priya, id);
    await notTold(nadia, id);
  });
});
