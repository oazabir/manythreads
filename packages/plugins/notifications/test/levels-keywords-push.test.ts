import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync } from 'node:crypto';
import {
  GetNotificationKeywordsResponse,
  GetNotificationLevelsResponse,
  GetPushStateResponse,
  ListNotificationsResponse,
  PushPayload,
  PutChannelLevelResponse,
  type Notification,
  type NotificationLevel,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVATE_BODY } from '../src/push.ts';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, priya, lena } = personas;

// P14-09: a channel's level decides what may interrupt a person (all, mentions and keywords, nothing), a keyword counts as a mention, Do not
// disturb still holds everything, and a browser signed up for push gets a push that says who and where, not what, for a private conversation.

const vapid = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString();
const realFetch = globalThis.fetch;
const pushes: Array<{ url: string; body: Buffer; authorization: string }> = [];
let pushStatus = 201;

let w: World;
let dev = '';
let general = '';
beforeAll(async () => {
  process.env['MANYTHREADS_VAPID_PRIVATE_KEY'] = vapid;
  // The push services are not reachable from a test: a call to one is recorded and answered; everything else goes through.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname.endsWith('googleapis.com')) {
      pushes.push({ url, body: Buffer.from(init?.body as Uint8Array), authorization: String((init?.headers as Record<string, string>)['Authorization']) });
      return new Response(null, { status: pushStatus });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  general = await w.channelId('engineering', 'general');
  for (const who of [nadia, rafi, priya]) for (const c of [dev, general]) await w.call(who, 'POST', `/api/channels/${c}/join`);
}, 180_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env['MANYTHREADS_VAPID_PRIVATE_KEY'];
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const inbox = async (who: Persona): Promise<Notification[]> => ListNotificationsResponse.parse(ok(await w.call(who, 'GET', '/api/notifications'))).items;
const about = async (who: Persona, messageId: string): Promise<Notification[]> => (await inbox(who)).filter((n) => n.refId === messageId);
const told = (who: Persona, messageId: string): Promise<Notification[]> =>
  eventually(async () => {
    const items = await about(who, messageId);
    return items.length > 0 ? items : undefined;
  }, 20_000, `${who.key} to be told about ${messageId}`);
/** After the outbox has drained, `who` has no notification about the message. */
const notTold = async (who: Persona, messageId: string): Promise<void> => {
  await drained(w);
  expect(await about(who, messageId), `${who.key} should not be told`).toEqual([]);
};
const setLevel = async (who: Persona, channelId: string, level: NotificationLevel | null) =>
  PutChannelLevelResponse.parse(ok(await w.call(who, 'PUT', `/api/notifications/levels/${channelId}`, { level })));
const setKeywords = async (who: Persona, keywords: string[]) => GetNotificationKeywordsResponse.parse(ok(await w.call(who, 'PUT', '/api/notifications/keywords', { keywords })));
const setDefault = async (who: Persona, level: NotificationLevel) => w.call(who, 'PUT', '/api/notifications/workspace-level', { level });
const dm = async (from: Persona, to: Persona): Promise<string> => {
  const res = await w.call<{ dm: { channel: { id: string } } }>(from, 'POST', '/api/dms', { personIds: [to.personId] });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.dm.channel.id;
};

describe('channel levels', () => {
  it('by default a plain channel message notifies nobody; "all messages" tells the person who asked for it, only', async () => {
    const quiet = await post(nadia, dev, 'lunch is here');
    await notTold(rafi, quiet);

    expect(await setLevel(rafi, dev, 'all')).toEqual({ channelId: dev, level: 'all', effective: 'all' });
    const loud = await post(nadia, dev, 'standup moved to 10:30');
    const items = await told(rafi, loud);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', channelId: dev, actorName: nadia.name, keyword: null });
    await notTold(priya, loud);
    await notTold(nadia, loud);

    // the person's own messages never tell them, and their choice for one channel does not reach another
    const own = await post(rafi, dev, 'on it');
    const other = await post(nadia, general, 'welcome everyone');
    await notTold(rafi, own);
    await notTold(rafi, other);

    // taking the choice away returns the channel to the default
    expect(await setLevel(rafi, dev, null)).toEqual({ channelId: dev, level: null, effective: 'mentions' });
    const after = await post(nadia, dev, 'one more thing');
    await notTold(rafi, after);
  });

  it('"mentions and keywords only" still lets a mention and a followed thread through; "nothing" lets nothing through, a mention included', async () => {
    await setLevel(rafi, dev, 'mentions');
    const named = await post(nadia, dev, 'can you check this @rafi');
    expect((await told(rafi, named))[0]).toMatchObject({ kind: 'mention', keyword: null });

    await setLevel(rafi, dev, 'nothing');
    const muted = await post(nadia, dev, 'again @rafi please');
    const control = await post(nadia, dev, 'and you @priya');
    await told(priya, control);
    await notTold(rafi, muted);
    await setKeywords(rafi, ['staging']);
    const keyworded = await post(nadia, dev, 'staging is down');
    await notTold(rafi, keyworded);
    await setKeywords(rafi, []);
    await setLevel(rafi, dev, null);
  });

  it('a direct message tells by default, and stops telling once the person sets it to mentions only', async () => {
    const channel = await dm(nadia, rafi);
    const first = await post(nadia, channel, 'got a minute?');
    expect((await told(rafi, first))[0]).toMatchObject({ kind: 'dm' });
    await setLevel(rafi, channel, 'mentions');
    const second = await post(nadia, channel, 'ping');
    await notTold(rafi, second);
    await setLevel(rafi, channel, null);
  });

  it('lists the person’s own choices; a channel they cannot read cannot be set', async () => {
    await setLevel(priya, general, 'nothing');
    const list = GetNotificationLevelsResponse.parse(ok(await w.call(priya, 'GET', '/api/notifications/levels')));
    expect(list.workspaceDefault).toBe('mentions');
    expect(list.channels).toEqual([{ channelId: general, channelName: 'general', channelKind: 'channel', level: 'nothing' }]);
    expect(GetNotificationLevelsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/levels'))).channels).toEqual([]);
    expect((await w.call(lena, 'PUT', `/api/notifications/levels/${dev}`, { level: 'all' })).status).toBe(403);
    expect((await w.call(priya, 'PUT', `/api/notifications/levels/${dev}`, { level: 'loud' })).status).toBe(400);
    await setLevel(priya, general, null);
  });

  it('a workspace admin sets the default for team channels; a member cannot; a person’s own choice still wins', async () => {
    expect((await setDefault(nadia, 'all')).status).toBe(403);
    ok(await setDefault(omar, 'all'));
    try {
      await setLevel(priya, dev, 'mentions');
      const msg = await post(nadia, dev, 'release notes are up');
      await told(rafi, msg); // no choice of his own: follows the default
      await notTold(priya, msg); // her own choice wins
      const levels = GetNotificationLevelsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/levels')));
      expect(levels.workspaceDefault).toBe('all');
    } finally {
      ok(await setDefault(omar, 'mentions'));
      await setLevel(priya, dev, null);
    }
    const msg = await post(nadia, dev, 'back to quiet');
    await notTold(rafi, msg);
  });
});

describe('keywords', () => {
  it('a keyword counts as a mention, as a whole word in any case, and says which word it was', async () => {
    expect(await setKeywords(rafi, ['Deploy failed', 'rollback', 'deploy failed'])).toEqual({ keywords: ['deploy failed', 'rollback'] });
    expect(GetNotificationKeywordsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/keywords'))).keywords).toEqual(['deploy failed', 'rollback']);

    const hit = await post(nadia, dev, 'The Deploy failed on step 3');
    expect((await told(rafi, hit))[0]).toMatchObject({ kind: 'mention', keyword: 'deploy failed', channelId: dev });
    const caps = await post(nadia, dev, 'ROLLBACK!');
    expect((await told(rafi, caps))[0]).toMatchObject({ kind: 'mention', keyword: 'rollback' });

    const partOfWord = await post(nadia, dev, 'rollbacks are slow and the deployment failed');
    await notTold(rafi, partOfWord);
    await notTold(priya, hit);
    await notTold(nadia, hit);
  });

  it('being named wins over a keyword in the same message, whichever is handled first', async () => {
    const both = await post(nadia, dev, 'rollback now @rafi');
    await eventually(async () => {
      const rows = await about(rafi, both);
      return rows.length === 1 && rows[0]?.keyword === null ? rows : undefined;
    }, 20_000, 'the mention to replace the keyword');
    expect(await about(rafi, both)).toHaveLength(1);
  });

  it('only counts in channels the person joined, and in their direct messages; the author is never told by their own words', async () => {
    const private1 = await dm(nadia, rafi);
    const inDm = await post(nadia, private1, 'did the rollback finish?');
    expect((await told(rafi, inDm))[0]).toMatchObject({ kind: 'mention', keyword: 'rollback' });
    const own = await post(rafi, dev, 'I will rollback');
    await notTold(rafi, own);
    // a channel of another team that Rafi never joined
    const support = await w.channelId('customer-support', 'general').catch(() => null);
    if (support) {
      const msg = await post(personas.sameera, support, 'rollback of the macro');
      await notTold(rafi, msg);
    }
  });

  it('never tells a person of a message in a private channel they are not in, thread replies included; a member is told and the push hides channel and text', async () => {
    expect(await setKeywords(rafi, ['launchcode', 'rollback', 'deploy failed'])).toEqual({ keywords: ['deploy failed', 'launchcode', 'rollback'] });
    expect(await setKeywords(priya, ['launchcode'])).toEqual({ keywords: ['launchcode'] });
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'keyword-private', private: true }), 201);
    const priv = created.channel.id;
    for (const who of [nadia, priya]) expect((await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: who.personId })).status).toBeLessThan(300);
    const b = browser();
    await subscribe(priya, b);

    const root = await post(nadia, priv, 'launchcode is 0000');
    const reply = ok(await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${priv}/messages`, { channelId: priv, body: 'again: launchcode', threadRootId: root }), 201).id;
    expect((await told(priya, root))[0]).toMatchObject({ kind: 'mention', keyword: 'launchcode', channelId: priv });
    await told(priya, reply);
    await notTold(rafi, root);
    await notTold(rafi, reply);

    await eventually(async () => (sentTo(b).length > 0 ? true : undefined), 20_000, 'the push to the member');
    const payload = open(b, sentTo(b)[0]!.body);
    expect(payload.body).toBe(PRIVATE_BODY);
    expect(JSON.stringify(payload)).not.toContain('keyword-private');
    expect(JSON.stringify(payload)).not.toContain('0000');
    expect(await setKeywords(rafi, ['rollback', 'deploy failed'])).toEqual({ keywords: ['deploy failed', 'rollback'] });
    expect(await setKeywords(priya, [])).toEqual({ keywords: [] });
    ok(await w.call(priya, 'POST', '/api/notifications/push/unsubscribe', { endpoint: b.endpoint }));
  });

  it('refuses what cannot be matched with a reason, and more than twenty', async () => {
    const empty = await w.call<{ message?: string }>(rafi, 'PUT', '/api/notifications/keywords', { keywords: ['!!!'] });
    expect(empty.status).toBe(400);
    const many = await w.call(rafi, 'PUT', '/api/notifications/keywords', { keywords: Array.from({ length: 21 }, (_, i) => `word${i}`) });
    expect(many.status).toBe(400);
    expect((await w.call(rafi, 'PUT', '/api/notifications/keywords', { keywords: ['one two three four five'] })).status).toBe(400);
    // nothing was changed by the refusals
    expect(GetNotificationKeywordsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/keywords'))).keywords).toEqual(['deploy failed', 'rollback']);
    expect(await setKeywords(rafi, [])).toEqual({ keywords: [] });
  });
});

describe('Do not disturb still holds everything', () => {
  it('a message that would tell a person by level or keyword is held while Do not disturb is on, and delivered when it ends', async () => {
    await setLevel(rafi, dev, 'all');
    await setKeywords(rafi, ['hotfix']);
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: true }));
    const a = await post(nadia, dev, 'hotfix is out');
    await drained(w);
    const held = await w.system(async (tx) => (await tx.query<{ held: boolean }>('SELECT held_at IS NOT NULL AS held FROM app.notifications WHERE person_id = $1 AND ref_id = $2', [rafi.personId, a])).rows);
    expect(held).toEqual([{ held: true }]);
    expect(await about(rafi, a)).toEqual([]);
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: false }));
    expect((await told(rafi, a))[0]).toMatchObject({ kind: 'mention', keyword: 'hotfix' });
    await setLevel(rafi, dev, null);
    await setKeywords(rafi, []);
  });
});

// ---- browser push ---------------------------------------------------------------------------------------------------------------

function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const endpoint = `https://fcm.googleapis.com/fcm/send/${Math.random().toString(36).slice(2)}`;
  return { ecdh, auth, endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
type Browser = ReturnType<typeof browser>;
function open(b: Browser, body: Buffer): PushPayload {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]!);
  const cipherText = body.subarray(21 + body[20]!);
  const ikm = Buffer.from(hkdfSync('sha256', b.ecdh.computeSecret(asPublic), b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), asPublic]), 32));
  const d = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  d.setAuthTag(cipherText.subarray(cipherText.length - 16));
  const plain = Buffer.concat([d.update(cipherText.subarray(0, cipherText.length - 16)), d.final()]);
  return PushPayload.parse(JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8')));
}
const subscribe = (who: Persona, b: Browser) => w.call<{ subscriptions: number }>(who, 'POST', '/api/notifications/push/subscribe', { endpoint: b.endpoint, keys: b.keys, label: 'Test browser' });
const sentTo = (b: Browser) => pushes.filter((p) => p.url === b.endpoint);
const stored = async (b: Browser): Promise<number> =>
  w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.push_subscriptions WHERE endpoint = $1', [b.endpoint])).rows[0]!.n);

describe('browser push', () => {
  it('says whether the server can push and what key the browser needs', async () => {
    const state = GetPushStateResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/push')));
    expect(state).toMatchObject({ available: true, subscriptions: 0 });
    expect(Buffer.from(state.publicKey!, 'base64url')).toHaveLength(65);
  });

  it('sends a signed, encrypted push to a signed-up browser: sender and channel, the text only for a public channel', async () => {
    const b = browser();
    expect(ok(await subscribe(rafi, b))).toEqual({ subscriptions: 1 });
    const id = await post(nadia, dev, 'the staging password is hunter2 @rafi');
    await told(rafi, id);
    await eventually(async () => (sentTo(b).length > 0 ? true : undefined), 20_000, 'the push to be sent');
    const sent = sentTo(b)[0]!;
    expect(sent.authorization).toMatch(/^vapid t=.+, k=.+$/);
    const payload = open(b, sent.body);
    expect(payload).toMatchObject({ title: `${nadia.name} mentioned you in #dev`, body: 'the staging password is hunter2 @rafi' });
    expect(payload.url).toBe(`/open?channel=${dev}&message=${id}`);

    // a direct message: who, not what
    const channel = await dm(nadia, rafi);
    const secret = await post(nadia, channel, 'my new laptop password is correct-horse-battery');
    await eventually(async () => (sentTo(b).length > 1 ? true : undefined), 20_000, 'the second push');
    const second = open(b, sentTo(b)[1]!.body);
    expect(second.title).toBe(`${nadia.name} sent you a message`);
    expect(second.body).toBe(PRIVATE_BODY);
    expect(JSON.stringify(second)).not.toContain('correct-horse');
    expect(secret).toBeTruthy();
    // the bytes on the wire are not the text either
    expect(sentTo(b)[1]!.body.toString('utf8')).not.toContain('correct-horse');
  });

  it('does not push while Do not disturb is on, for a notification already read, or after the browser is removed', async () => {
    const b = browser();
    await subscribe(priya, b);
    ok(await w.call(priya, 'PUT', '/api/presence/dnd', { enabled: true }));
    const held = await post(nadia, dev, 'hello @priya while you rest');
    await drained(w);
    expect(sentTo(b)).toHaveLength(0);
    ok(await w.call(priya, 'PUT', '/api/presence/dnd', { enabled: false }));
    await told(priya, held);
    await eventually(async () => (sentTo(b).length === 1 ? true : undefined), 20_000, 'the push after Do not disturb ended');

    expect(ok(await w.call(priya, 'POST', '/api/notifications/push/unsubscribe', { endpoint: b.endpoint }))).toEqual({ subscriptions: 0 });
    const after = await post(nadia, dev, 'one more @priya');
    await told(priya, after);
    await drained(w);
    await new Promise((r) => setTimeout(r, 500));
    expect(sentTo(b)).toHaveLength(1);
  });

  it('removes a browser the push service says is gone, and refuses endpoints and keys it cannot use', async () => {
    const gone = browser();
    await subscribe(rafi, gone);
    pushStatus = 410;
    try {
      const id = await post(nadia, dev, 'another one @rafi');
      await told(rafi, id);
      await eventually(async () => (sentTo(gone).length > 0 ? true : undefined), 20_000, 'a push attempt');
      await eventually(async () => ((await stored(gone)) === 0 ? true : undefined), 20_000, 'the gone browser to be removed');
    } finally {
      pushStatus = 201;
    }
    const internal = await w.call(rafi, 'POST', '/api/notifications/push/subscribe', { endpoint: 'https://127.0.0.1/x', keys: browser().keys });
    expect(internal.status).toBe(400);
    const plain = await w.call(rafi, 'POST', '/api/notifications/push/subscribe', { endpoint: 'http://fcm.googleapis.com/x', keys: browser().keys });
    expect(plain.status).toBe(400);
    const badKeys = await w.call(rafi, 'POST', '/api/notifications/push/subscribe', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'A'.repeat(60), auth: 'B'.repeat(20) } });
    expect(badKeys.status).toBe(400);
  });

  it('a browser belongs to one person: signing up the same browser as someone else moves it', async () => {
    const shared = browser();
    await subscribe(rafi, shared);
    expect(ok(await subscribe(priya, shared))).toEqual({ subscriptions: 1 });
    const mine = GetPushStateResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications/push')));
    expect(mine.subscriptions).toBe(0); // the push service said 410 for his other browser in the test before; the shared one left
    const id = await post(nadia, dev, 'for rafi @rafi');
    await told(rafi, id);
    await drained(w);
    await new Promise((r) => setTimeout(r, 500));
    expect(sentTo(shared)).toHaveLength(0);
  });
});
