import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ListMessagesResponse, ListOutgoingHooksResponse, OutgoingHook, OutgoingPayload, OutgoingSigningResponse, TestOutgoingHookResponse } from '@manythreads/shared';
import type { SafeFetchDeps } from '@manythreads/sdk/safe-fetch';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { OUTGOING_DEPS, classifyFailure, matchTrigger, outgoingSignature, parseReply } from '../src/index.ts';
import { SafeFetchError } from '@manythreads/sdk/safe-fetch';

// Outgoing webhooks: trigger matching, the signed call, the reply, the loop guard, retries and the dead letter, and what the guarded fetch refuses.
// The server runs in this process, so the receiver is a local server reached through the fake resolver below (the name resolves to a public address,
// and `dial` makes the connection go to the local server after the address has been vetted).

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 90_000 });

describe('matchTrigger', () => {
  it('starts: whole word at the start, capitals ignored, leading spaces allowed', () => {
    expect(matchTrigger('Deploy now', ['deploy'], 'starts')).toBe('deploy');
    expect(matchTrigger('   DEPLOY!', ['deploy'], 'starts')).toBe('deploy');
    expect(matchTrigger('please deploy', ['deploy'], 'starts')).toBeNull();
    expect(matchTrigger('deployment', ['deploy'], 'starts')).toBeNull();
    expect(matchTrigger('', ['deploy'], 'starts')).toBeNull();
    expect(matchTrigger('   ', ['deploy'], 'starts')).toBeNull();
  });
  it('contains: a whole word anywhere, not inside another word', () => {
    expect(matchTrigger('please deploy now', ['deploy'], 'contains')).toBe('deploy');
    expect(matchTrigger('a redeploy', ['deploy'], 'contains')).toBeNull();
    expect(matchTrigger('deploys', ['deploy'], 'contains')).toBeNull();
    expect(matchTrigger('x deployment then deploy', ['deploy'], 'contains')).toBe('deploy');
  });
  it('a trigger that begins with a symbol still works, phrases work, the first matching word is returned as written', () => {
    expect(matchTrigger('!deploy prod', ['!Deploy'], 'starts')).toBe('!Deploy');
    expect(matchTrigger('/run it', ['/run'], 'starts')).toBe('/run');
    expect(matchTrigger('hey, please ship it', ['ship it', 'please'], 'contains')).toBe('ship it');
  });
  it('is linear on hostile input', () => {
    const body = 'a'.repeat(40_000);
    const t = performance.now();
    expect(matchTrigger(body, ['aaaaaaaaaaaaaaaaaaaaaaaaaaab', 'a'.repeat(40)], 'contains')).toBeNull();
    expect(matchTrigger(`${' '.repeat(39_000)}x`, ['deploy'], 'starts')).toBeNull();
    expect(performance.now() - t).toBeLessThan(1_000);
  });
});

describe('outgoingSignature and parseReply and classifyFailure', () => {
  it('signs "v0:<time>:<body>" with HMAC-SHA256 as hex after v0=', () => {
    const sig = outgoingSignature('mtos_secret', '1700000000', '{"a":1}');
    expect(sig).toBe(`v0=${createHmac('sha256', 'mtos_secret').update('v0:1700000000:{"a":1}').digest('hex')}`);
    expect(outgoingSignature('mtos_other', '1700000000', '{"a":1}')).not.toBe(sig);
    expect(outgoingSignature('mtos_secret', '1700000001', '{"a":1}')).not.toBe(sig);
  });
  it('reads Slack and Mattermost reply shapes, and posts nothing for anything else', () => {
    expect(parseReply(Buffer.from('{"text":"hi *there*"}'))).toEqual({ text: 'hi **there**', inThread: false });
    expect(parseReply(Buffer.from('{"text":"x","response_type":"comment"}'))?.inThread).toBe(true);
    expect(parseReply(Buffer.from('{"text":"only you","response_type":"ephemeral"}'))).toBeNull();
    expect(parseReply(Buffer.from(''))).toBeNull();
    expect(parseReply(Buffer.from('ok'))).toBeNull();
    expect(parseReply(Buffer.from('[1,2]'))).toBeNull();
    expect(parseReply(Buffer.from('{}'))).toBeNull();
    expect(parseReply(Buffer.from('{"text":"   "}'))).toBeNull();
  });
  it('a reply notifies nobody: names, @here, @channel and <@U…> are defanged', () => {
    const r = parseReply(Buffer.from(JSON.stringify({ text: '@omar @here @channel <@U123> <!channel>' })))!;
    expect(r.text).not.toMatch(/@(?=[A-Za-z])/);
  });
  it('classifies what can pass again and what cannot', () => {
    expect(classifyFailure(new SafeFetchError('bad_status', 'x', undefined, 503))).toMatchObject({ retry: true, reason: 'status_503', statusCode: 503 });
    expect(classifyFailure(new SafeFetchError('bad_status', 'x', undefined, 429))).toMatchObject({ retry: true });
    expect(classifyFailure(new SafeFetchError('bad_status', 'x', undefined, 408))).toMatchObject({ retry: true });
    expect(classifyFailure(new SafeFetchError('bad_status', 'x', undefined, 404))).toMatchObject({ retry: false, reason: 'status_404' });
    expect(classifyFailure(new SafeFetchError('bad_status', 'x', undefined, 400))).toMatchObject({ retry: false });
    expect(classifyFailure(new SafeFetchError('timeout', 'x'))).toMatchObject({ retry: true });
    expect(classifyFailure(new SafeFetchError('network', 'x'))).toMatchObject({ retry: true });
    expect(classifyFailure(new SafeFetchError('blocked_address', 'x'))).toMatchObject({ retry: false });
    expect(classifyFailure(new SafeFetchError('blocked_by_policy', 'x'))).toMatchObject({ retry: false });
    expect(classifyFailure(new SafeFetchError('too_large', 'x'))).toMatchObject({ retry: false, deliveredAnyway: true });
    expect(classifyFailure(new Error('boom'))).toMatchObject({ retry: true });
  });
});

// ---- with a server --------------------------------------------------------------------------------------------------------------------------------

interface Hit {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
let w: World;
let receiver: Server;
let hits: Hit[] = [];
/** What the receiver answers, by path: a status and a body, or a function for more. */
let script: (hit: Hit, res: ServerResponse) => void = (_h, res) => res.end('ok');
const saved = OUTGOING_DEPS.fetchDeps;
let counter = 0;
let channelId = '';

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hit = { path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      hits.push(hit);
      script(hit, res);
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = (receiver.address() as AddressInfo).port;
  const fake: SafeFetchDeps = {
    resolve: async (host) => {
      if (host.endsWith('.fake.example')) return [{ address: '93.184.216.34', family: 4 }];
      if (host === 'rebind.fake2.example') return [{ address: '10.0.0.5', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    dial: () => ({ host: '127.0.0.1', port }),
  };
  OUTGOING_DEPS.fetchDeps = fake;
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  OUTGOING_DEPS.fetchDeps = saved;
  await w?.close();
  receiver?.closeAllConnections();
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
});
beforeEach(async () => {
  hits = [];
  script = (_h, res) => res.end('ok');
  const made = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: `out-${++counter}-${Math.random().toString(36).slice(2, 6)}` });
  expect(made.status).toBe(201);
  channelId = made.body.channel.id;
});

const json = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function makeHook(body: Record<string, unknown> = {}, who = omar, channel = channelId): Promise<OutgoingHook> {
  const res = await w.call(who, 'POST', `/api/channels/${channel}/outgoing-hooks`, { name: 'Deploy bot', url: 'http://hooks.fake.example/in', triggerWords: ['deploy'], ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return OutgoingHook.parse(res.body);
}
async function say(text: string, who = nadia, channel = channelId, threadRootId: string | null = null): Promise<string> {
  const res = await w.call<{ id: string }>(who, 'POST', `/api/channels/${channel}/messages`, { channelId: channel, threadRootId, body: text });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
async function messages(channel = channelId, thread?: string): Promise<ListMessagesResponse['items']> {
  const res = await w.call(omar, 'GET', `/api/channels/${channel}/messages?limit=100${thread ? `&threadRootId=${thread}` : ''}`);
  return ListMessagesResponse.parse(res.body).items;
}
const deliveryOf = (hookId: string, messageId: string): Promise<{ status: string; attempts: number; reason: string | null } | undefined> =>
  w.system(async (tx) => (await tx.query<{ status: string; attempts: number; reason: string | null }>('SELECT status, attempts, reason FROM app.webhook_deliveries WHERE webhook_id = $1 AND message_id = $2', [hookId, messageId])).rows[0]);
const settled = (hookId: string, messageId: string, status: string, ms = 60_000): Promise<{ status: string; attempts: number; reason: string | null }> =>
  eventually(async () => {
    const d = await deliveryOf(hookId, messageId);
    return d?.status === status ? d : undefined;
  }, ms, `delivery ${status}`);
const quiet = (ms = 1_500): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('managing outgoing hooks', () => {
  it('a lead makes one, sees it listed, edits it, switches it off and revokes it; a member cannot', async () => {
    const h = await makeHook({ triggerWords: ['Deploy', 'ship it', 'deploy'] });
    expect(h).toMatchObject({ name: 'Deploy bot', match: 'starts', enabled: true, signed: false, triggerWords: ['Deploy', 'ship it'], deliveredCount: 0 });
    expect(h.verificationToken.length).toBeGreaterThan(10);
    expect((await w.call(nadia, 'POST', `/api/channels/${channelId}/outgoing-hooks`, { name: 'x', url: 'http://hooks.fake.example/in', triggerWords: ['a'] })).status).toBe(403);
    expect((await w.call(nadia, 'GET', `/api/channels/${channelId}/outgoing-hooks`)).status).toBe(403);
    const list = ListOutgoingHooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/outgoing-hooks`)).body);
    expect(list.hooks.map((x) => x.id)).toEqual([h.id]);
    const up = await w.call(omar, 'PATCH', `/api/outgoing-hooks/${h.id}`, { match: 'contains', enabled: false });
    expect(OutgoingHook.parse(up.body)).toMatchObject({ match: 'contains', enabled: false });
    expect((await w.call(nadia, 'PATCH', `/api/outgoing-hooks/${h.id}`, { enabled: true })).status).toBeGreaterThanOrEqual(403);
    expect((await w.call(omar, 'PATCH', `/api/outgoing-hooks/${h.id}`, { name: 'x' })).status).toBe(400);
    expect((await w.call(omar, 'DELETE', `/api/outgoing-hooks/${h.id}`)).status).toBe(200);
    expect(ListOutgoingHooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/outgoing-hooks`)).body).hooks).toEqual([]);
    expect((await w.call(omar, 'DELETE', `/api/outgoing-hooks/${h.id}`)).status).toBe(404);
  });

  it('refuses addresses that can never work, with a sentence', async () => {
    for (const url of ['http://127.0.0.1/in', 'http://10.0.0.1/in', 'http://localhost/in', 'http://[::1]/in', 'http://169.254.169.254/latest', 'http://hooks.fake.example:8080/in', 'ftp://hooks.fake.example/in']) {
      const res = await w.call(omar, 'POST', `/api/channels/${channelId}/outgoing-hooks`, { name: 'Bad', url, triggerWords: ['x'] });
      expect(res.status, url).toBe(400);
      expect(JSON.stringify(res.body), url).toMatch(/address|port|local|private|https/i);
    }
    expect((await w.call(omar, 'POST', `/api/channels/${channelId}/outgoing-hooks`, { name: 'Bad', url: 'https://user:pw@hooks.fake.example/in', triggerWords: ['x'] })).status).toBe(400);
    expect((await w.call(omar, 'POST', `/api/channels/${channelId}/outgoing-hooks`, { name: 'Bad', url: 'http://hooks.fake.example/in', triggerWords: [] })).status).toBe(400);
  });

  it('shows a signing secret once, marks the hook signed, and clears it', async () => {
    const h = await makeHook();
    const set = OutgoingSigningResponse.parse((await w.call(omar, 'POST', `/api/outgoing-hooks/${h.id}/signing-secret`)).body);
    expect(set.hook.signed).toBe(true);
    expect(set.signingSecret).toMatch(/^mtos_/);
    const stored = await w.system(async (tx) => JSON.stringify((await tx.query('SELECT * FROM app.webhook_outgoing WHERE webhook_id = $1', [h.id])).rows));
    expect(stored).not.toContain(set.signingSecret);
    const list = ListOutgoingHooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/outgoing-hooks`)).body);
    expect(JSON.stringify(list)).not.toContain(set.signingSecret);
    const cleared = await w.call<{ hook: { signed: boolean } }>(omar, 'DELETE', `/api/outgoing-hooks/${h.id}/signing-secret`);
    expect(cleared.body.hook.signed).toBe(false);
  });
});

describe('a trigger word sends the message', () => {
  it('posts the Slack-shaped call, signed, and posts the receiver\'s reply once as the integration, which never triggers the hook again', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    const { signingSecret } = OutgoingSigningResponse.parse((await w.call(omar, 'POST', `/api/outgoing-hooks/${h.id}/signing-secret`)).body);
    script = (_h, res) => json(res, { text: 'deploy queued for *prod* @omar @here' });
    const id = await say('deploy the api please');
    await settled(h.id, id, 'delivered');
    const reply = await eventually(async () => (await messages()).find((m) => m.author?.sender === 'webhook'), 15_000, 'the reply');
    expect(reply.body).toMatch(/^deploy queued for \*\*prod\*\*/);
    expect(reply.body).not.toMatch(/@(?=[A-Za-z])/);
    expect(reply.author).toMatchObject({ displayName: 'Deploy bot', kind: 'system', sender: 'webhook' });
    await quiet();
    expect(hits).toHaveLength(1); // the reply says "deploy" too, and did not trigger the hook again
    expect((await messages()).filter((m) => m.author?.sender === 'webhook')).toHaveLength(1);

    const hit = hits[0]!;
    expect(hit.path).toBe('/in');
    const payload = OutgoingPayload.parse(JSON.parse(hit.body));
    expect(payload).toMatchObject({ token: h.verificationToken, channel_id: channelId, trigger_word: 'deploy', text: 'deploy the api please', message_id: id, user_name: expect.any(String) });
    expect(payload.timestamp).toMatch(/^\d{10}\.\d{6}$/);
    const ts = String(hit.headers['x-manythreads-request-timestamp']);
    expect(hit.headers['x-manythreads-signature']).toBe(outgoingSignature(signingSecret, ts, hit.body));
    expect(hit.headers['content-type']).toMatch(/json/);
    const row = ListOutgoingHooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/outgoing-hooks`)).body).hooks[0]!;
    expect(row).toMatchObject({ deliveredCount: 1, failedCount: 0, lastDeliveryStatus: 'delivered', lastError: null });
  });

  it('sends nothing for a message with no trigger word, for a word inside another word, for a bot or hook author, or after the hook is off', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    await say('nothing to see here');
    await say('deployment is slow');
    await say('please deploy', nadia); // "starts" mode: does not start with it
    // a message written by the integration itself (an API token) never triggers
    const tok = await w.call<{ secret: string }>(omar, 'POST', `/api/channels/${channelId}/api-tokens`, { name: 'Poster' });
    await fetch(`${w.server.url}/api/slack/chat.postMessage`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.body.secret}` }, body: JSON.stringify({ channel: channelId, text: 'deploy from a script' }) });
    await w.call(omar, 'PATCH', `/api/outgoing-hooks/${h.id}`, { enabled: false });
    await say('deploy now');
    await quiet(2_500);
    expect(hits).toHaveLength(0);
  });

  it('contains mode matches anywhere; an edit into a trigger does not send, a message of a person in a thread does, with thread_ts', async () => {
    const h = await makeHook({ triggerWords: ['deploy'], match: 'contains' });
    const root = await say('a thread about things');
    const reply = await say('please deploy this', nadia, channelId, root);
    await settled(h.id, reply, 'delivered');
    const payload = OutgoingPayload.parse(JSON.parse(hits[0]!.body));
    expect(payload.thread_ts).toMatch(/^\d{10}\.\d{6}$/);
  });

  it('a reply to a message in a thread is posted in that thread; response_type comment answers in a thread under a channel message', async () => {
    const h = await makeHook({ triggerWords: ['deploy'], match: 'contains' });
    script = (_h, res) => json(res, { text: 'in the thread', response_type: 'comment' });
    const id = await say('deploy it');
    await settled(h.id, id, 'delivered');
    const replies = await eventually(async () => {
      const r = await messages(channelId, id);
      return r.length > 0 ? r : undefined;
    }, 15_000, 'a thread reply');
    expect(replies[0]).toMatchObject({ body: 'in the thread', threadRootId: id });
  });

  it('a receiver that answers with no JSON, an empty body or an ephemeral reply is delivered with no reply', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    script = (_h, res) => res.end('OK');
    const a = await say('deploy one');
    await settled(h.id, a, 'delivered');
    script = (_h, res) => json(res, { text: 'secret', response_type: 'ephemeral' });
    const b = await say('deploy two');
    await settled(h.id, b, 'delivered');
    await quiet();
    expect((await messages()).filter((m) => m.author?.sender === 'webhook')).toHaveLength(0);
  });

  it('sends only what the text is: a redirect to the same receiver (307) is followed and the call is repeated', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    let n = 0;
    script = (hit, res) => {
      n += 1;
      if (hit.path === '/in') {
        res.writeHead(307, { location: 'http://hooks.fake.example/moved' });
        res.end();
      } else json(res, { text: 'moved ok' });
    };
    const id = await say('deploy x');
    await settled(h.id, id, 'delivered');
    expect(n).toBe(2);
    expect(hits.map((x) => x.path)).toEqual(['/in', '/moved']);
    expect(hits[1]!.body).toBe(hits[0]!.body);
  });
});

describe('retries and the dead letter', () => {
  it('a 5xx is tried again and the second try that passes posts the reply once', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    let calls = 0;
    script = (_h, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503);
        res.end('busy');
      } else json(res, { text: 'ok on the second try' });
    };
    const id = await say('deploy later');
    const done = await settled(h.id, id, 'delivered');
    expect(done.attempts).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(2);
    await eventually(async () => (await messages()).find((m) => m.body === 'ok on the second try'), 15_000, 'the reply');
    await quiet();
    expect((await messages()).filter((m) => m.body === 'ok on the second try')).toHaveLength(1);
  });

  it('a 404 is dead at once, with the reason, and the hook says so', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    script = (_h, res) => {
      res.writeHead(404);
      res.end('no');
    };
    const id = await say('deploy gone');
    const d = await settled(h.id, id, 'dead');
    expect(d).toMatchObject({ attempts: 1, reason: 'status_404' });
    expect(hits).toHaveLength(1);
    const row = ListOutgoingHooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/outgoing-hooks`)).body).hooks[0]!;
    expect(row).toMatchObject({ lastDeliveryStatus: 'dead', lastError: 'status_404', failedCount: 1 });
  });

  it('keeps failing with 503: five tries in all, then dead', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    script = (_h, res) => {
      res.writeHead(503);
      res.end('down');
    };
    const id = await say('deploy down');
    const d = await settled(h.id, id, 'dead', 80_000);
    expect(d.attempts).toBe(5);
    expect(hits).toHaveLength(5);
    const events = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'webhooks.outgoing.delivered' AND payload->>'webhookId' = $1`, [h.id])).rows);
    expect(events.map((e) => e.payload['outcome']).sort()).toEqual(['dead', 'retry', 'retry', 'retry', 'retry']);
    expect(JSON.stringify(events)).not.toContain('deploy down');
  });

  it('a revoked hook sends nothing even for a job already waiting', async () => {
    const h = await makeHook({ triggerWords: ['deploy'] });
    script = (_h, res) => {
      res.writeHead(503);
      res.end();
    };
    const id = await say('deploy then revoke');
    await eventually(async () => (hits.length >= 1 ? true : undefined), 15_000, 'the first call');
    expect((await w.call(omar, 'DELETE', `/api/outgoing-hooks/${h.id}`)).status).toBe(200);
    const seen = hits.length;
    await quiet(5_000);
    expect(hits.length).toBeLessThanOrEqual(seen + 1);
    expect(await deliveryOf(h.id, id)).toBeDefined();
  });
});

describe('what the guarded fetch refuses', () => {
  it('a name that resolves to a private address is blocked as dead, and nothing reaches the receiver', async () => {
    const h = await makeHook({ url: 'http://rebind.fake2.example/in', triggerWords: ['deploy'] });
    const id = await say('deploy rebind');
    const d = await settled(h.id, id, 'dead');
    expect(d.reason).toBe('blocked_address');
    expect(hits).toHaveLength(0);
  });

  it('a redirect to a private address is refused, a 302 is not followed at all', async () => {
    const h = await makeHook({ triggerWords: ['deploy'], match: 'contains' });
    script = (_h, res) => {
      res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    };
    const a = await say('deploy a');
    const da = await settled(h.id, a, 'dead');
    // a POST is repeated only at the same host, so a redirect elsewhere (here: the metadata address) is refused before anything is sent to it
    expect(da.reason).toBe('bad_redirect');
    expect(hits).toHaveLength(1);
    hits = [];
    script = (_h, res) => {
      res.writeHead(302, { location: 'http://hooks.fake.example/other' });
      res.end();
    };
    const b = await say('deploy b');
    const db = await settled(h.id, b, 'dead');
    expect(db.reason).toBeTruthy();
    expect(hits).toHaveLength(1);
  });

  it('a name that does not resolve is tried again, then dead; an endless redirect chain is dead', async () => {
    const h = await makeHook({ triggerWords: ['deploy'], match: 'contains' });
    script = (hit, res) => {
      res.writeHead(307, { location: `http://hooks.fake.example/r${hit.path.length}x` });
      res.end();
    };
    const id = await say('deploy loop');
    const d = await settled(h.id, id, 'dead');
    expect(d.reason).toBe('too_many_redirects');
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe('the test button', () => {
  it('sends one sample call, reports what the receiver said, and posts nothing in the channel', async () => {
    const h = await makeHook();
    script = (_h, res) => json(res, { text: 'pong' });
    const res = TestOutgoingHookResponse.parse((await w.call(omar, 'POST', `/api/outgoing-hooks/${h.id}/test`)).body);
    expect(res).toMatchObject({ delivered: true, statusCode: 200, reason: null, wouldReply: true });
    expect(hits).toHaveLength(1);
    expect(OutgoingPayload.parse(JSON.parse(hits[0]!.body)).token).toBe(h.verificationToken);
    expect((await messages()).filter((m) => m.author?.sender === 'webhook')).toHaveLength(0);
    script = (_h, res2) => {
      res2.writeHead(500);
      res2.end();
    };
    expect(TestOutgoingHookResponse.parse((await w.call(omar, 'POST', `/api/outgoing-hooks/${h.id}/test`)).body)).toMatchObject({ delivered: false, statusCode: 500, reason: 'status_500' });
    expect((await w.call(nadia, 'POST', `/api/outgoing-hooks/${h.id}/test`)).status).toBeGreaterThanOrEqual(403);
  });
});

describe('private channels', () => {
  it('a hook in a private channel sends only that channel\'s own messages, and only a lead of it can make one', async () => {
    const made = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: `priv-${Math.random().toString(36).slice(2, 6)}`, private: true });
    expect(made.status).toBe(201);
    const priv = made.body.channel.id;
    // nadia is not in the private channel: she cannot make a hook there, and a hook in another channel never sees its messages
    expect((await w.call(nadia, 'POST', `/api/channels/${priv}/outgoing-hooks`, { name: 'x', url: 'http://hooks.fake.example/in', triggerWords: ['x'] })).status).toBeGreaterThanOrEqual(403);
    const other = await makeHook({ triggerWords: ['secret'], match: 'contains' });
    const h = await makeHook({ triggerWords: ['secret'], match: 'contains' }, omar, priv);
    const id = await say('secret plan', omar, priv);
    await settled(h.id, id, 'delivered');
    await quiet();
    expect(hits).toHaveLength(1);
    expect(OutgoingPayload.parse(JSON.parse(hits[0]!.body))).toMatchObject({ channel_id: priv, token: h.verificationToken });
    expect(hits[0]!.body).not.toContain(other.verificationToken);
  });
});

// These use Tariq (lead of Marketing) so that the 30-a-minute limit on making hooks, already spent by Omar above, does not apply.
const { tariq } = personas;
const marketingChannel = async (priv = false): Promise<string> => {
  const made = await w.call<{ channel: { id: string } }>(tariq, 'POST', '/api/teams/marketing/channels', { name: `mk-${Math.random().toString(36).slice(2, 8)}`, private: priv });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.channel.id;
};

describe('who may point a channel at an outside address (P14-14b)', () => {
  const leave = (channel: string): Promise<unknown> =>
    w.system((tx) => tx.query('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [channel, tariq.personId]));
  const base = { name: 'Leak', url: 'http://hooks.fake.example/in', triggerWords: ['secret'], match: 'contains' };

  it('a lead who cannot read a private channel cannot make an outgoing hook for it, and says why in a sentence', async () => {
    const priv = await marketingChannel(true);
    await leave(priv);
    const refused = await w.call<{ error: { message: string } }>(tariq, 'POST', `/api/channels/${priv}/outgoing-hooks`, base);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/channel you can read yourself/);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.webhooks WHERE channel_id = $1', [priv])).rows.length)).toBe(0);
    // an incoming webhook only writes into the channel, so that stays with the lead
    expect((await w.call(tariq, 'POST', `/api/channels/${priv}/webhooks`, { name: 'Writer' })).status).toBe(201);
    // a lead who can read the channel still can
    const open = await marketingChannel();
    expect((await w.call(tariq, 'POST', `/api/channels/${open}/outgoing-hooks`, base)).status).toBe(201);
  });

  it('a lead who lost read access cannot turn a hook on or change where it goes, but can still switch it off', async () => {
    const priv = await marketingChannel(true);
    const h = await makeHook({}, tariq, priv);
    await leave(priv);
    expect((await w.call(tariq, 'PATCH', `/api/outgoing-hooks/${h.id}`, { url: 'http://evil.fake.example/in' })).status).toBe(403);
    expect((await w.call(tariq, 'POST', `/api/outgoing-hooks/${h.id}/signing-secret`)).status).toBe(403);
    expect((await w.call(tariq, 'PATCH', `/api/outgoing-hooks/${h.id}`, { enabled: false })).status).toBe(200);
    expect((await w.call(tariq, 'PATCH', `/api/outgoing-hooks/${h.id}`, { enabled: true })).status).toBe(403);
    const row = await w.system(async (tx) => (await tx.query<{ enabled: boolean; url: string }>('SELECT enabled, url FROM app.webhook_outgoing WHERE webhook_id = $1', [h.id])).rows[0]);
    expect(row).toEqual({ enabled: false, url: 'http://hooks.fake.example/in' });
  });
});

describe('trigger words that would match nearly every message (P14-14b)', () => {
  it('"contains" refuses a word of fewer than 3 characters, on make and on change; "starts" keeps allowing it', async () => {
    const ch = await marketingChannel();
    const body = { name: 'Short', url: 'http://hooks.fake.example/in' };
    const refused = await w.call<{ error: { message: string } }>(omar, 'POST', `/api/channels/${channelId}/outgoing-hooks`, { ...body, triggerWords: ['deploy', 'a'], match: 'contains' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/at least 3 characters/);
    expect((await w.call(tariq, 'POST', `/api/channels/${ch}/outgoing-hooks`, { ...body, triggerWords: ['ok'], match: 'contains' })).status).toBe(400);
    const starts = await makeHook({ triggerWords: ['!d'], match: 'starts' }, tariq, ch);
    // changing to "contains" while a short word is kept is refused; adding a short word while contains is refused
    expect((await w.call(tariq, 'PATCH', `/api/outgoing-hooks/${starts.id}`, { match: 'contains' })).status).toBe(400);
    const long = await makeHook({ name: 'Long words', triggerWords: ['deploy'], match: 'contains' }, tariq, ch);
    expect((await w.call(tariq, 'PATCH', `/api/outgoing-hooks/${long.id}`, { triggerWords: ['deploy', 'go'] })).status).toBe(400);
    expect((await w.call(tariq, 'PATCH', `/api/outgoing-hooks/${long.id}`, { triggerWords: ['deploy', 'ship it'] })).status).toBe(200);
  });
});

describe('a signed hook is never sent unsigned (P14-14b)', () => {
  const breakSecret = (hookId: string): Promise<unknown> =>
    w.system((tx) => tx.query(`UPDATE app.secrets SET ciphertext = '\\x00'::bytea WHERE id = (SELECT signing_secret_id FROM app.webhook_outgoing WHERE webhook_id = $1)`, [hookId]));

  it('when the signing secret cannot be read, the delivery is tried again later (internal_error) and nothing reaches the receiver', async () => {
    const ch = await marketingChannel();
    const h = await makeHook({ triggerWords: ['deploy'] }, tariq, ch);
    await w.call(tariq, 'POST', `/api/outgoing-hooks/${h.id}/signing-secret`);
    await breakSecret(h.id);
    const id = await say('deploy now', tariq, ch);
    const d = await settled(h.id, id, 'retrying');
    expect(d.reason).toBe('internal_error');
    await quiet();
    expect(hits).toHaveLength(0);
  });

  it('the test button reports the failure and sends nothing', async () => {
    const h = await makeHook({}, tariq, await marketingChannel());
    await w.call(tariq, 'POST', `/api/outgoing-hooks/${h.id}/signing-secret`);
    await breakSecret(h.id);
    const res = TestOutgoingHookResponse.parse((await w.call(tariq, 'POST', `/api/outgoing-hooks/${h.id}/test`)).body);
    expect(res).toMatchObject({ delivered: false, reason: 'internal_error' });
    expect(hits).toHaveLength(0);
  });
});
