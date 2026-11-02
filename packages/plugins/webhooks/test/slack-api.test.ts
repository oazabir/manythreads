import { ApiTokenWithSecret, ListApiTokensResponse, ListMessagesResponse, TestApiTokenResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { messageIdToTs } from '../src/ts.ts';

// The Slack-shaped API end to end: a lead makes a token, a script calls the five methods with it, and what it writes is an ordinary message of the channel
// written by the integration (never a person), with the edit history, the reaction and the audit line of any other.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: World;
let channelId: string;
let otherChannelId: string;
let counter = 0;
let channelName = 'dev';
// A channel holds at most 20 integrations, so each group of tests works in a channel of its own.
async function freshChannel(): Promise<void> {
  const made = await w.call<{ channel: { id: string; name: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: `api-t${++counter}-${Math.random().toString(36).slice(2, 6)}` });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  channelId = made.body.channel.id;
  channelName = made.body.channel.name;
}

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  channelId = await w.channelId('engineering', 'dev');
  const made = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'api-other' });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  otherChannelId = made.body.channel.id;
}, 180_000);
afterAll(async () => {
  await w?.close();
});

interface Made {
  id: string;
  secret: string;
}
async function makeToken(body: Record<string, unknown> = {}, channel = channelId, who = omar): Promise<Made> {
  const res = await w.call(who, 'POST', `/api/channels/${channel}/api-tokens`, { name: `script-${Math.random().toString(36).slice(2, 8)}`, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { token, secret } = ApiTokenWithSecret.parse(res.body);
  return { id: token.id, secret };
}

interface SlackAnswer {
  status: number;
  headers: Headers;
  body: Record<string, unknown> & { ok: boolean; error?: string; ts?: string; channel?: string; message?: Record<string, unknown> };
}
async function slack(method: string, token: string | null, body: Record<string, unknown> | string = {}, opts: { form?: boolean; header?: boolean; verb?: string } = {}): Promise<SlackAnswer> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = typeof body === 'string' ? body : new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString();
  } else {
    headers['content-type'] = 'application/json; charset=utf-8';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (token !== null && opts.header !== false) headers['authorization'] = `Bearer ${token}`;
  const verb = opts.verb ?? 'POST';
  const res = await fetch(`${w.server.url}/api/slack/${method}`, { method: verb, headers, ...(verb === 'GET' ? {} : { body: payload }) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as SlackAnswer['body'] };
}

async function messages(who = omar, channel = channelId): Promise<ListMessagesResponse['items']> {
  const res = await w.call(who, 'GET', `/api/channels/${channel}/messages?limit=100`);
  expect(res.status).toBe(200);
  return ListMessagesResponse.parse(res.body).items;
}
const actorOf = (hookId: string): Promise<string> => w.system(async (tx) => (await tx.query<{ actor_id: string }>('SELECT actor_id FROM app.webhooks WHERE id = $1', [hookId])).rows[0]!.actor_id);

describe('making a token', () => {
  beforeAll(freshChannel);
  it('shows the secret once, keeps only a hash, and lists the token without it', async () => {
    const m = await makeToken({ name: 'Deploy script' });
    expect(m.secret).toMatch(/^mtat_[A-Za-z0-9_-]{43}$/);
    const list = ListApiTokensResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/api-tokens`)).body);
    const row = list.tokens.find((t) => t.id === m.id)!;
    expect(row).toMatchObject({ name: 'Deploy script', channelIds: [channelId], methods: ['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove'], callCount: 0, lastUsedAt: null });
    expect(list.apiBase).toMatch(/\/api\/slack\/$/);
    expect(JSON.stringify(list)).not.toContain(m.secret);
    const stored = await w.system(async (tx) => (await tx.query('SELECT * FROM app.webhook_secrets WHERE webhook_id = $1', [m.id])).rows);
    expect(JSON.stringify(stored)).not.toContain(m.secret);
    expect(stored).toHaveLength(1);
  });

  it('refuses someone who is not a lead, and shows them nothing', async () => {
    expect((await w.call(nadia, 'POST', `/api/channels/${channelId}/api-tokens`, { name: 'Nope' })).status).toBe(403);
    expect((await w.call(nadia, 'GET', `/api/channels/${channelId}/api-tokens`)).status).toBe(403);
    expect([403, 404]).toContain((await w.call(sameera, 'POST', `/api/channels/${channelId}/api-tokens`, { name: 'Nope' })).status);
  });

  it('limits a token to the channels and the methods the lead picked', async () => {
    const m = await makeToken({ moreChannelIds: [otherChannelId], methods: ['chat.postMessage'] });
    const list = ListApiTokensResponse.parse((await w.call(omar, 'GET', `/api/channels/${otherChannelId}/api-tokens`)).body);
    expect(list.tokens.find((t) => t.id === m.id)).toMatchObject({ channelId, channelIds: [channelId, otherChannelId], methods: ['chat.postMessage'] });
    // a channel of another team cannot be added
    const cs = await w.channelId('customer-support', 'general').catch(() => null);
    if (cs) expect((await w.call(omar, 'POST', `/api/channels/${channelId}/api-tokens`, { name: 'Cross', moreChannelIds: [cs] })).status).toBeGreaterThanOrEqual(400);
    expect((await w.call(omar, 'POST', `/api/channels/${channelId}/api-tokens`, { name: 'x', methods: ['chat.delete'] })).status).toBe(400);
    expect((await w.call(omar, 'POST', `/api/channels/${channelId}/api-tokens`, { name: 'x', extra: 1 })).status).toBe(400);
  });

  it('writes an audit line that holds neither the token nor its hash', async () => {
    const m = await makeToken();
    const events = await w.system(async (tx) => (await tx.query<{ type: string; payload: unknown }>(`SELECT type, payload FROM app.events WHERE payload->>'webhookId' = $1`, [m.id])).rows);
    expect(events.map((e) => e.type)).toContain('webhooks.token.changed');
    expect(JSON.stringify(events)).not.toContain(m.secret);
  });
});

describe('auth.test and the way a call is read', () => {
  beforeAll(freshChannel);
  it('says who the token is, by header, by form field and by GET', async () => {
    const m = await makeToken({ name: 'Who am I' });
    const byHeader = await slack('auth.test', m.secret);
    expect(byHeader.status).toBe(200);
    expect(byHeader.body).toMatchObject({ ok: true, user: 'Who am I', user_id: m.id, bot_id: m.id, is_enterprise_install: false });
    expect(byHeader.body['channels']).toEqual([{ id: channelId, name: channelName }]);
    expect((await slack('auth.test', null, { token: m.secret }, { form: true, header: false })).body.ok).toBe(true);
    expect((await slack('auth.test', m.secret, '', { verb: 'GET' })).body.ok).toBe(true);
  });

  it('never reads the token from the query string (it would land in access logs); the body and the header still carry it', async () => {
    const m = await makeToken({ name: 'Query' });
    const viaGet = await fetch(`${w.server.url}/api/slack/auth.test?token=${m.secret}`);
    expect(await viaGet.json()).toEqual({ ok: false, error: 'not_authed' });
    const viaPost = await fetch(`${w.server.url}/api/slack/auth.test?token=${m.secret}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await viaPost.json()).toEqual({ ok: false, error: 'not_authed' });
    // a token in the body still works even when a different (junk) one is in the query
    const mixed = await fetch(`${w.server.url}/api/slack/auth.test?token=mtat_${'A'.repeat(43)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: m.secret }) });
    expect(((await mixed.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('answers not_authed with no token and invalid_auth with a wrong, malformed or other kind of token, always HTTP 200', async () => {
    const none = await slack('auth.test', null);
    expect([none.status, none.body]).toEqual([200, { ok: false, error: 'not_authed' }]);
    for (const bad of [`mtat_${'A'.repeat(43)}`, 'mtat_short', 'xoxb-1234', 'mtwh_' + 'A'.repeat(43)]) {
      const r = await slack('auth.test', bad);
      expect([r.status, r.body]).toEqual([200, { ok: false, error: 'invalid_auth' }]);
    }
  });

  it('reads a JSON body and a form body, blocks sent as text, and says invalid_json for a broken body', async () => {
    const m = await makeToken();
    const form = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'from a form', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*bold* in a block' } }] }, { form: true });
    expect(form.body, JSON.stringify(form.body)).toMatchObject({ ok: true });
    const msg = (await messages()).find((x) => messageIdToTs(x.id) === form.body.ts)!;
    expect(msg.body).toContain('from a form');
    expect(msg.body).toContain('**bold** in a block');
    const broken = await slack('chat.postMessage', m.secret, '{"channel": ', {});
    expect(broken.body).toEqual({ ok: false, error: 'invalid_json' });
  });
});

describe('chat.postMessage', () => {
  beforeAll(freshChannel);
  it('posts as the integration with the Webhook mark and answers { ok, channel, ts, message }', async () => {
    const m = await makeToken({ name: 'Release bot' });
    const res = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'Release *1.2* is out, see <https://example.com/r|notes>' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channel: channelId, message: { type: 'message', text: expect.stringContaining('**1.2**'), user: m.id } });
    const msg = (await messages(nadia)).find((x) => messageIdToTs(x.id) === res.body.ts)!;
    expect(msg.authorId).toBe(await actorOf(m.id));
    expect(msg.body).toBe('Release **1.2** is out, see [notes](https://example.com/r)');
    expect(msg.author).toMatchObject({ displayName: 'Release bot', kind: 'system', sender: 'webhook' });
    const row = ListApiTokensResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/api-tokens`)).body).tokens.find((t) => t.id === m.id)!;
    expect(row).toMatchObject({ callCount: 1, lastStatus: 'posted' });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('finds the channel by id or by name, and only the token\'s own channels', async () => {
    const m = await makeToken();
    expect((await slack('chat.postMessage', m.secret, { channel: `#${channelName}`, text: 'by name' })).body.ok).toBe(true);
    expect((await slack('chat.postMessage', m.secret, { channel: channelName, text: 'by bare name' })).body.ok).toBe(true);
    expect((await slack('chat.postMessage', m.secret, { channel: '#nothing-here', text: 'x' })).body).toEqual({ ok: false, error: 'channel_not_found' });
    expect((await slack('chat.postMessage', m.secret, { text: 'x' })).body).toEqual({ ok: false, error: 'channel_not_found' });
    // a well-formed id of a channel the token was not given: the same word whether or not that channel exists
    expect((await slack('chat.postMessage', m.secret, { channel: otherChannelId, text: 'x' })).body).toEqual({ ok: false, error: 'not_in_channel' });
    expect((await slack('chat.postMessage', m.secret, { channel: '00000000-0000-7000-8000-000000000000', text: 'x' })).body).toEqual({ ok: false, error: 'not_in_channel' });
    expect((await messages(omar, otherChannelId)).some((x) => x.body === 'x')).toBe(false);
  });

  it('posts in a thread with thread_ts, and names the thread in the answer', async () => {
    const m = await makeToken();
    const root = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'thread root' });
    const reply = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'a reply', thread_ts: root.body.ts });
    expect(reply.body).toMatchObject({ ok: true, message: { thread_ts: root.body.ts } });
    const rootId = (await messages()).find((x) => messageIdToTs(x.id) === root.body.ts)!.id;
    const replies = ListMessagesResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}`)).body).items;
    expect(replies.find((x) => messageIdToTs(x.id) === reply.body.ts)?.threadRootId).toBe(rootId);
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, text: 'x', thread_ts: '1.000000' })).body).toEqual({ ok: false, error: 'thread_not_found' });
  });

  it('refuses no text, an over-long text and a bad blocks value with the Slack words', async () => {
    const m = await makeToken();
    expect((await slack('chat.postMessage', m.secret, { channel: channelId })).body).toEqual({ ok: false, error: 'no_text' });
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, text: '   ' })).body).toEqual({ ok: false, error: 'no_text' });
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, text: 'x'.repeat(40_001) })).body).toEqual({ ok: false, error: 'msg_too_long' });
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, blocks: 'not json' })).body).toEqual({ ok: false, error: 'invalid_blocks' });
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, text: 'x', attachments: { no: 'array' } })).body).toEqual({ ok: false, error: 'invalid_attachments' });
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, text: 42 })).body).toEqual({ ok: false, error: 'invalid_arguments' });
  });

  it('counts the blocks it did not show and never fails because of them', async () => {
    const m = await makeToken();
    const res = await slack('chat.postMessage', m.secret, {
      channel: channelId,
      blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Title' } }, { type: 'rich_text', elements: [] }, { type: 'input', element: {} }],
    });
    expect(res.body).toMatchObject({ ok: true, skipped_blocks: 2 });
  });

  it('notifies nobody: a name, @here and @channel in the text are plain words with no mention behind them', async () => {
    const m = await makeToken();
    const res = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'ping @omar @nadia @here @channel <@U123> <!here> <!channel>' });
    expect(res.body.ok).toBe(true);
    const msg = (await messages()).find((x) => messageIdToTs(x.id) === res.body.ts)!;
    expect(msg.body).not.toMatch(/@(?=[A-Za-z])/);
    const mentions = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_mentions WHERE message_id = $1', [msg.id])).rows);
    expect(mentions).toHaveLength(0);
    const notes = await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.notifications WHERE payload::text LIKE '%' || $1 || '%'`, [msg.id]).catch(() => ({ rows: [] }))).rows);
    expect(notes).toHaveLength(0);
  });

  it('refuses an archived channel', async () => {
    const made = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'api-archived' });
    const id = made.body.channel.id;
    const m = await makeToken({}, id);
    expect((await slack('chat.postMessage', m.secret, { channel: id, text: 'before' })).body.ok).toBe(true);
    expect((await w.call(omar, 'POST', `/api/channels/${id}/archive`)).status).toBeLessThan(300);
    // an archived channel's integration is switched off with it, or at least refuses with the Slack word
    const after = await slack('chat.postMessage', m.secret, { channel: id, text: 'after' });
    expect(after.body.ok).toBe(false);
    expect(['is_archived', 'invalid_auth', 'channel_not_found', 'not_in_channel']).toContain(after.body.error);
  });
});

describe('chat.update', () => {
  beforeAll(freshChannel);
  it('edits the integration\'s own message, keeps the old text as a version, and nobody is notified', async () => {
    const m = await makeToken();
    const posted = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'Deploy started' });
    const upd = await slack('chat.update', m.secret, { channel: channelId, ts: posted.body.ts, text: 'Deploy **finished** @omar' });
    expect(upd.body).toMatchObject({ ok: true, channel: channelId, ts: posted.body.ts, text: expect.stringContaining('**finished**') });
    const msg = (await messages()).find((x) => messageIdToTs(x.id) === posted.body.ts)!;
    expect(msg.body).not.toMatch(/@(?=[A-Za-z])/);
    expect(msg.body).toContain('**finished**');
    expect(msg.editedAt).not.toBeNull();
    const versions = await w.system(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.message_versions WHERE message_id = $1', [msg.id])).rows);
    expect(versions.map((v) => v.body)).toContain('Deploy started');
    const mentions = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_mentions WHERE message_id = $1', [msg.id])).rows);
    expect(mentions).toHaveLength(0);
  });

  it('refuses a message somebody else wrote: a person, another token, an incoming webhook', async () => {
    const m = await makeToken();
    const other = await makeToken();
    const person = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, threadRootId: null, body: 'written by Nadia' });
    expect(person.status, JSON.stringify(person.body)).toBe(201);
    const personTs = messageIdToTs(person.body.id);
    expect((await slack('chat.update', m.secret, { channel: channelId, ts: personTs, text: 'hijack' })).body).toEqual({ ok: false, error: 'cant_update_message' });
    const theirs = await slack('chat.postMessage', other.secret, { channel: channelId, text: 'from another token' });
    expect((await slack('chat.update', m.secret, { channel: channelId, ts: theirs.body.ts, text: 'hijack' })).body).toEqual({ ok: false, error: 'cant_update_message' });
    expect((await messages()).find((x) => x.id === person.body.id)!.body).toBe('written by Nadia');
    expect((await slack('chat.update', m.secret, { channel: channelId, ts: '1700000000.000000', text: 'x' })).body).toEqual({ ok: false, error: 'message_not_found' });
    expect((await slack('chat.update', m.secret, { channel: channelId, ts: 'garbage', text: 'x' })).body).toEqual({ ok: false, error: 'message_not_found' });
    expect((await slack('chat.update', m.secret, { channel: channelId, ts: theirs.body.ts })).body).toEqual({ ok: false, error: 'no_text' });
  });

  it('does not touch a message that was deleted', async () => {
    const m = await makeToken();
    const posted = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'soon gone' });
    const id = (await messages()).find((x) => messageIdToTs(x.id) === posted.body.ts)!.id;
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [id]));
    expect((await slack('chat.update', m.secret, { channel: channelId, ts: posted.body.ts, text: 'back?' })).body).toEqual({ ok: false, error: 'message_not_found' });
  });
});

describe('reactions.add and reactions.remove', () => {
  beforeAll(freshChannel);
  it('adds and removes a reaction by Slack name, once each', async () => {
    const m = await makeToken();
    const posted = await slack('chat.postMessage', m.secret, { channel: channelId, text: 'react to me' });
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: posted.body.ts, name: 'thumbsup' })).body).toEqual({ ok: true });
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: posted.body.ts, name: ':thumbsup:' })).body).toEqual({ ok: false, error: 'already_reacted' });
    const msg = (await messages()).find((x) => messageIdToTs(x.id) === posted.body.ts)!;
    expect(msg.reactions).toEqual([expect.objectContaining({ emoji: '👍', count: 1 })]);
    expect((await slack('reactions.remove', m.secret, { channel: channelId, timestamp: posted.body.ts, name: 'thumbsup' })).body).toEqual({ ok: true });
    expect((await slack('reactions.remove', m.secret, { channel: channelId, timestamp: posted.body.ts, name: 'thumbsup' })).body).toEqual({ ok: false, error: 'no_reaction' });
  });

  it('reacts to a message a person wrote, refuses unknown names, and says message_not_found for a ts that names nothing', async () => {
    const m = await makeToken();
    const person = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, threadRootId: null, body: 'a person speaks' });
    const ts = messageIdToTs(person.body.id);
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: ts, name: 'white_check_mark' })).body.ok).toBe(true);
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: ts, name: 'definitely_not_an_emoji_name' })).body).toEqual({ ok: false, error: 'invalid_name' });
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: ts })).body).toEqual({ ok: false, error: 'invalid_name' });
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: '1700000000.000000', name: 'tada' })).body).toEqual({ ok: false, error: 'message_not_found' });
  });
});

describe('scopes, limits and revocation', () => {
  beforeAll(freshChannel);
  it('answers missing_scope for a method the token was not allowed, and still answers auth.test', async () => {
    const m = await makeToken({ methods: ['chat.postMessage'] });
    expect((await slack('chat.postMessage', m.secret, { channel: channelId, text: 'ok' })).body.ok).toBe(true);
    const denied = await slack('chat.update', m.secret, { channel: channelId, ts: '1.000000', text: 'x' });
    expect(denied.body).toMatchObject({ ok: false, error: 'missing_scope', needed: 'chat.update' });
    expect((await slack('reactions.add', m.secret, { channel: channelId, timestamp: '1.000000', name: 'tada' })).body.error).toBe('missing_scope');
    expect((await slack('auth.test', m.secret)).body.ok).toBe(true);
  });

  it('a rotated token stops working at once, the new one works; a revoked token is refused and leaves the list', async () => {
    const m = await makeToken({ name: 'Rotated' });
    expect((await slack('auth.test', m.secret)).body.ok).toBe(true);
    const rotated = ApiTokenWithSecret.parse((await w.call(omar, 'POST', `/api/api-tokens/${m.id}/rotate`)).body);
    expect(rotated.secret).not.toBe(m.secret);
    expect((await slack('auth.test', m.secret)).body).toEqual({ ok: false, error: 'invalid_auth' });
    expect((await slack('auth.test', rotated.secret)).body.ok).toBe(true);
    expect((await w.call(nadia, 'POST', `/api/api-tokens/${m.id}/rotate`)).status).toBeGreaterThanOrEqual(403);
    expect((await w.call(omar, 'DELETE', `/api/api-tokens/${m.id}`)).status).toBe(200);
    expect((await slack('auth.test', rotated.secret)).body).toEqual({ ok: false, error: 'invalid_auth' });
    expect(ListApiTokensResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/api-tokens`)).body).tokens.some((t) => t.id === m.id)).toBe(false);
    expect((await w.call(omar, 'DELETE', `/api/api-tokens/${m.id}`)).status).toBe(404);
  });

  it('a lead can send a test message that carries the integration\'s name and a usable ts', async () => {
    const m = await makeToken({ name: 'Tested' });
    const res = TestApiTokenResponse.parse((await w.call(omar, 'POST', `/api/api-tokens/${m.id}/test`)).body);
    const msg = (await messages()).find((x) => x.id === res.messageId)!;
    expect(messageIdToTs(msg.id)).toBe(res.ts);
    expect(msg.author).toMatchObject({ displayName: 'Tested', sender: 'webhook' });
  });

  it('limits one token to its own number of calls a minute, answering 429 with Retry-After and the Slack word', async () => {
    const m = await makeToken();
    let limited: SlackAnswer | null = null;
    for (let i = 0; i < 70 && limited === null; i++) {
      const r = await slack('auth.test', m.secret);
      if (r.status === 429) limited = r;
    }
    expect(limited, 'no 429 within 70 calls').not.toBeNull();
    expect(limited!.body).toEqual({ ok: false, error: 'rate_limited' });
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // another token is not held back by it
    const other = await makeToken();
    expect((await slack('auth.test', other.secret)).body.ok).toBe(true);
  });

  it('records every call of a known token in the audit trail with the method and the outcome, never the text or the token', async () => {
    const m = await makeToken();
    await slack('chat.postMessage', m.secret, { channel: channelId, text: 'secret-looking text SENTINEL-4412' });
    await slack('chat.postMessage', m.secret, { channel: '#nowhere', text: 'SENTINEL-4412' });
    const rows = await w.system(async (tx) =>
      (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'webhooks.token.used' AND payload->>'webhookId' = $1 ORDER BY occurred_at`, [m.id])).rows,
    );
    expect(rows.map((r) => [r.payload['method'], r.payload['outcome']])).toEqual([
      ['chat.postMessage', 'ok'],
      ['chat.postMessage', 'channel_not_found'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('SENTINEL-4412');
    expect(JSON.stringify(rows)).not.toContain(m.secret);
  });

  it('junk from one address never uses up the room of a valid caller (only failures count, not every call)', async () => {
    const good = await makeToken();
    // far more than the old per-address cap of 600 calls a minute; the lock turns the junk into 429s, which must not count against a right token
    for (let i = 0; i < 650; i++) await slack('auth.test', `mtat_${String(i).padStart(43, 'C')}`);
    const ok = await slack('auth.test', good.secret);
    expect([ok.status, ok.body.ok]).toEqual([200, true]);
  });

  it('locks an address that keeps presenting unknown tokens, but never refuses a right token', async () => {
    const good = await makeToken();
    let locked = 0;
    for (let i = 0; i < 45; i++) {
      const r = await slack('auth.test', `mtat_${String(i).padStart(43, 'B')}`);
      if (r.status === 429) locked += 1;
    }
    expect(locked).toBeGreaterThan(0);
    const ok = await slack('auth.test', good.secret);
    expect([ok.status, ok.body.ok]).toEqual([200, true]);
  });
});

describe('ts: a message is named by its id, both ways', () => {
  beforeAll(freshChannel);
  it('a ts from chat.postMessage finds exactly the message again, for twenty messages posted at once', async () => {
    const m = await makeToken();
    const posted = await Promise.all(Array.from({ length: 20 }, (_, i) => slack('chat.postMessage', m.secret, { channel: channelId, text: `burst ${i}` })));
    const stamps = posted.map((p) => p.body.ts as string);
    expect(new Set(stamps).size).toBe(20);
    expect(stamps.every((t) => /^\d{10}\.\d{6}$/.test(t))).toBe(true);
    const items = await messages(omar);
    for (let i = 0; i < 20; i++) {
      const found = items.find((x) => messageIdToTs(x.id) === stamps[i]);
      expect(found?.body).toBe(`burst ${i}`);
      const upd = await slack('chat.update', m.secret, { channel: channelId, ts: stamps[i], text: `edited ${i}` });
      expect(upd.body.ok, JSON.stringify(upd.body)).toBe(true);
    }
  });
});
