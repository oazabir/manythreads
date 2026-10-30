import { ListMessagesResponse, ListWebhooksResponse, MessagePostedPush, WebhookWithUrl } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import type { PluginTx } from '@manythreads/sdk';
import { loadMessage } from '../../notifications/src/service.ts';
import { request as httpRequest } from 'node:http';
import { githubSignature } from '../src/secrets.ts';

// Incoming webhooks end to end: a lead makes one, a sender posts to its secret address, the message lands in the channel written as the webhook.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: World;
let channelId: string;

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}
/** A WebSocket signed in through the test-only dev header (what a person with the channel open receives live). */
async function openSocket(who: typeof omar): Promise<{ frames: Frame[]; waitFor: (match: (f: Frame) => boolean, ms?: number) => Promise<Frame | undefined>; close: () => void }> {
  const header = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
  const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { 'x-manythreads-dev-actor': header } } as never);
  const frames: Frame[] = [];
  ws.onmessage = (e) => void frames.push(JSON.parse(String(e.data)) as Frame);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('socket failed to open'));
  });
  const waitFor = async (match: (f: Frame) => boolean, ms = 3_000): Promise<Frame | undefined> => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = frames.find(match);
      if (hit || Date.now() > until) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  // a ping round trip proves the upgrade was handled; the short wait lets the person lookup finish
  ws.send(JSON.stringify({ type: 'ping', id: 'hello', payload: {} }));
  await waitFor((f) => f.type === 'pong');
  await new Promise((r) => setTimeout(r, 150));
  return { frames, waitFor, close: () => ws.close() };
}

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  channelId = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

interface Made {
  id: string;
  url: string;
  path: string;
  secret: string;
}
async function make(name: string, who = omar): Promise<Made> {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/webhooks`, { name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const { webhook, url } = WebhookWithUrl.parse(res.body);
  const path = new URL(url).pathname;
  return { id: webhook.id, url, path, secret: path.split('/')[3]! };
}
async function hit(path: string, body: string | object, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Headers }> {
  const isText = typeof body === 'string';
  const res = await fetch(`${w.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': isText ? 'text/plain' : 'application/json', ...headers },
    body: isText ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}
async function messages(who = omar): Promise<ListMessagesResponse['items']> {
  const res = await w.call(who, 'GET', `/api/channels/${channelId}/messages?limit=50`);
  expect(res.status).toBe(200);
  return ListMessagesResponse.parse(res.body).items;
}
const authorOf = (hookId: string): Promise<string> =>
  w.system(async (tx) => (await tx.query<{ actor_id: string }>('SELECT actor_id FROM app.webhooks WHERE id = $1', [hookId])).rows[0]!.actor_id);

describe('making a webhook', () => {
  it('gives the secret address once and only a hash is stored', async () => {
    const m = await make('Build results');
    expect(m.url).toMatch(/\/hooks\/[0-9a-f-]{36}\/mtwh_[A-Za-z0-9_-]{43}$/);
    const list = ListWebhooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/webhooks`)).body);
    const row = list.webhooks.find((h) => h.id === m.id)!;
    expect(row.name).toBe('Build results');
    expect(row.lastUsedAt).toBeNull();
    expect(JSON.stringify(list)).not.toContain(m.secret);
    const stored = await w.system(async (tx) => (await tx.query('SELECT * FROM app.webhook_secrets WHERE webhook_id = $1', [m.id])).rows);
    expect(JSON.stringify(stored)).not.toContain(m.secret);
    expect(stored).toHaveLength(1);
  });

  it('refuses a member who is not a lead, and shows them nothing', async () => {
    const denied = await w.call(nadia, 'POST', `/api/channels/${channelId}/webhooks`, { name: 'Nope' });
    expect(denied.status).toBe(403);
    expect((await w.call(nadia, 'GET', `/api/channels/${channelId}/webhooks`)).status).toBe(403);
    const other = await w.call(sameera, 'POST', `/api/channels/${channelId}/webhooks`, { name: 'Nope' });
    expect([403, 404]).toContain(other.status);
  });

  it('refuses a second webhook with the same name in the channel and bad names', async () => {
    await make('Twin');
    const again = await w.call(omar, 'POST', `/api/channels/${channelId}/webhooks`, { name: 'twin' });
    expect(again.status).toBe(409);
    expect((await w.call(omar, 'POST', `/api/channels/${channelId}/webhooks`, { name: '' })).status).toBe(400);
    expect((await w.call(omar, 'POST', `/api/channels/${channelId}/webhooks`, { name: 'x', extra: 1 })).status).toBe(400);
  });

  it('writes audit events', async () => {
    const m = await make('Audited');
    const types = await w.system(async (tx) => (await tx.query<{ type: string }>(`SELECT type FROM app.events WHERE payload->>'webhookId' = $1 ORDER BY occurred_at`, [m.id])).rows.map((r) => r.type));
    expect(types).toContain('webhooks.hook.created');
  });
});

describe('a call to the secret address', () => {
  it('posts the message into the channel as the webhook, not as a person', async () => {
    const m = await make('GitHub Actions');
    const res = await hit(m.path, { text: 'Build **passed** on main', status: 'success' });
    expect(res.status, res.body).toBe(200);
    const { messageId } = JSON.parse(res.body) as { ok: boolean; messageId: string };
    const actor = await authorOf(m.id);
    const msg = (await messages(nadia)).find((x) => x.id === messageId)!;
    expect(msg.authorId).toBe(actor);
    expect(msg.body).toContain('Build **passed** on main');
    expect(msg.author).toMatchObject({ displayName: 'GitHub Actions', kind: 'system' });
    // notifications name the webhook, not "Bot"
    const facts = await w.system((tx) => loadMessage(tx as unknown as PluginTx, messageId));
    expect(facts?.authorName).toBe('GitHub Actions');
    const used = ListWebhooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/webhooks`)).body).webhooks.find((h) => h.id === m.id)!;
    expect(used.lastStatus).toBe('posted');
    expect(used.postedCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();
  });

  it('pushes the message live with its author named (the webhook, emoji first), not "Someone"', async () => {
    const res0 = await w.call(omar, 'POST', `/api/channels/${channelId}/webhooks`, { name: 'Deploys', emoji: '🚀' });
    expect(res0.status, JSON.stringify(res0.body)).toBe(201);
    const made = WebhookWithUrl.parse(res0.body);
    const path = new URL(made.url).pathname;
    const sock = await openSocket(nadia);
    try {
      const res = await hit(path, { text: 'Deployed **v42**' });
      expect(res.status, res.body).toBe(200);
      const { messageId } = JSON.parse(res.body) as { messageId: string };
      const frame = await sock.waitFor((f) => f.type === 'message.posted' && (f.payload as { messageId?: string }).messageId === messageId);
      expect(frame, 'no message.posted was pushed').toBeDefined();
      const push = MessagePostedPush.parse(frame!.payload);
      expect(push.message?.author).toMatchObject({ actorId: await authorOf(made.webhook.id), displayName: '🚀 Deploys', kind: 'system' });
    } finally {
      sock.close();
    }
  });

  it('formats a GitHub event and ignores an event it does not know with a 200 and a note', async () => {
    const m = await make('GitHub');
    const issue = await hit(
      m.path,
      { action: 'opened', issue: { number: 3, title: 'Crash on start', html_url: 'https://github.com/kahf/app/issues/3', user: { login: 'octo' } }, repository: { full_name: 'kahf/app', html_url: 'https://github.com/kahf/app' }, sender: { login: 'octo' } },
      { 'x-github-event': 'issues' },
    );
    expect(issue.status, issue.body).toBe(200);
    const mid = (JSON.parse(issue.body) as { messageId: string }).messageId;
    expect((await messages()).find((x) => x.id === mid)!.body).toContain('Crash on start');
    const star = await hit(m.path, { action: 'created', repository: { full_name: 'kahf/app' } }, { 'x-github-event': 'star' });
    expect(star.status).toBe(200);
    expect(JSON.parse(star.body)).toMatchObject({ ok: true, ignored: expect.stringContaining('star') });
    const ping = await hit(m.path, { zen: 'Keep it simple', hook_id: 1 }, { 'x-github-event': 'ping' });
    expect(ping.status).toBe(200);
  });

  it('does not let a sender ping people', async () => {
    const m = await make('Pinger');
    const res = await hit(m.path, { text: 'hello @omar and @everyone' });
    const mid = (JSON.parse(res.body) as { messageId: string }).messageId;
    const body = (await messages()).find((x) => x.id === mid)!.body;
    expect(body).not.toMatch(/@(?=[A-Za-z])/);
  });

  it('gives the same 404 for an unknown id, a wrong secret, a rotated secret and a revoked webhook', async () => {
    const m = await make('Rotating');
    const wrong = await hit(m.path.replace(m.secret, `mtwh_${'A'.repeat(43)}`), { text: 'x' });
    const unknown = await hit(`/hooks/00000000-0000-4000-8000-000000000000/${m.secret}`, { text: 'x' });
    const junk = await hit('/hooks/not-an-id/not-a-secret', { text: 'x' });
    expect([wrong.status, unknown.status, junk.status]).toEqual([404, 404, 404]);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.body).toBe(junk.body);

    const rotated = WebhookWithUrl.parse((await w.call(omar, 'POST', `/api/webhooks/${m.id}/rotate`)).body);
    const newPath = new URL(rotated.url).pathname;
    expect(newPath).not.toBe(m.path);
    const old = await hit(m.path, { text: 'old' });
    expect(old.status).toBe(404);
    expect(old.body).toBe(wrong.body);
    expect((await hit(newPath, { text: 'new' })).status).toBe(200);

    expect((await w.call(omar, 'DELETE', `/api/webhooks/${m.id}`)).status).toBe(200);
    const gone = await hit(newPath, { text: 'after revoke' });
    expect(gone.status).toBe(404);
    expect(gone.body).toBe(wrong.body);
    expect(wrong.body).not.toContain(m.secret);
    const list = ListWebhooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/webhooks`)).body);
    expect(list.webhooks.find((h) => h.id === m.id)).toBeUndefined();
    const types = await w.system(async (tx) => (await tx.query<{ type: string }>(`SELECT type FROM app.events WHERE payload->>'webhookId' = $1`, [m.id])).rows.map((r) => r.type));
    expect(types).toEqual(expect.arrayContaining(['webhooks.hook.created', 'webhooks.hook.rotated', 'webhooks.hook.revoked']));
  });

  it('only a lead can rotate or revoke', async () => {
    const m = await make('Guarded');
    expect([403, 404]).toContain((await w.call(nadia, 'POST', `/api/webhooks/${m.id}/rotate`)).status);
    expect([403, 404]).toContain((await w.call(nadia, 'DELETE', `/api/webhooks/${m.id}`)).status);
    expect((await hit(m.path, { text: 'still works' })).status).toBe(200);
  });

  it('refuses a body over the size cap with 413 and an unreadable one with 400', async () => {
    const m = await make('Big');
    const big = await hit(m.path, 'x'.repeat(1_048_576 + 10));
    expect(big.status).toBe(413);
    const empty = await hit(m.path, '   ');
    expect(empty.status).toBe(400);
  });

  it('stops a chunked body over the cap that declares no length, and keeps the webhook usable', async () => {
    const m = await make('Chunked');
    const url = new URL(`${w.server.url}${m.path}`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      const chunk = Buffer.alloc(256 * 1024, 120);
      for (let i = 0; i < 6; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
    expect((await hit(m.path, { text: 'small' })).status).toBe(200);
  });

  it('answers 409 for a channel that was archived after the webhook was made, and posts again when it is back', async () => {
    const created = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'hook-archived' });
    expect(created.status).toBe(201);
    const chan = created.body.channel.id;
    const made = WebhookWithUrl.parse((await w.call(omar, 'POST', `/api/channels/${chan}/webhooks`, { name: 'Late' })).body);
    const path = new URL(made.url).pathname;
    expect((await hit(path, { text: 'before' })).status).toBe(200);
    expect((await w.call(omar, 'POST', `/api/channels/${chan}/archive`)).status).toBe(200);
    const late = await hit(path, { text: 'while archived' });
    expect(late.status, late.body).toBe(409);
    expect(late.body).not.toContain(path.split('/')[3]!);
    expect((await w.call(omar, 'POST', `/api/channels/${chan}/webhooks`, { name: 'Another' })).status).toBe(409);
    expect((await w.call(omar, 'POST', `/api/channels/${chan}/unarchive`)).status).toBe(200);
    expect((await hit(path, { text: 'after' })).status).toBe(200);
  });

  it('checks the signature over the bytes that were sent, not over a re-printed copy of the JSON', async () => {
    const m = await make('Raw');
    const set = await w.call<{ signingSecret: string }>(omar, 'POST', `/api/webhooks/${m.id}/signing-secret`);
    const signing = set.body.signingSecret;
    const pretty = JSON.stringify({ text: 'spaced   out', status: 'success' }, null, 4);
    const compact = JSON.stringify(JSON.parse(pretty));
    const headers = (body: string): Record<string, string> => ({ 'content-type': 'application/json', 'x-hub-signature-256': githubSignature(signing, Buffer.from(body)) });
    // the signature of the compact form does not cover the pretty one
    expect((await hit(m.path, pretty as unknown as string, headers(compact))).status).toBe(401);
    expect((await hit(m.path, pretty as unknown as string, headers(pretty))).status).toBe(200);
  });

  it('limits calls per webhook', async () => {
    const m = await make('Busy');
    let limited: { status: number; headers: Headers } | undefined;
    for (let i = 0; i < 130 && !limited; i++) {
      const r = await hit(m.path, { text: `n${i}`, status: 'info' });
      if (r.status === 429) limited = r;
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    // another webhook is not affected
    const other = await make('Quiet');
    expect((await hit(other.path, { text: 'fine' })).status).toBe(200);
  });
});

describe('the signing secret', () => {
  it('requires a valid GitHub signature once one is set, and never shows it again', async () => {
    const m = await make('Signed');
    const set = await w.call<{ signingSecret: string }>(omar, 'POST', `/api/webhooks/${m.id}/signing-secret`);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const signing = set.body.signingSecret;
    expect(signing).toMatch(/^mtws_/);
    const list = await w.call(omar, 'GET', `/api/channels/${channelId}/webhooks`);
    expect(JSON.stringify(list.body)).not.toContain(signing);
    expect(ListWebhooksResponse.parse(list.body).webhooks.find((h) => h.id === m.id)!.signed).toBe(true);
    const sealed = await w.system(async (tx) => JSON.stringify((await tx.query('SELECT * FROM app.secrets')).rows));
    expect(sealed).not.toContain(signing);

    const payload = JSON.stringify({ action: 'opened', issue: { number: 1, title: 'Signed issue', html_url: 'https://github.com/kahf/app/issues/1', user: { login: 'o' } }, repository: { full_name: 'kahf/app' }, sender: { login: 'o' } });
    const send = (sig?: string): Promise<{ status: number; body: string }> =>
      hit(m.path, payload as unknown as string, { 'content-type': 'application/json', 'x-github-event': 'issues', ...(sig ? { 'x-hub-signature-256': sig } : {}) });
    expect((await send()).status).toBe(401);
    expect((await send('sha256=' + '0'.repeat(64))).status).toBe(401);
    expect((await send(githubSignature('mtws_wrong', Buffer.from(payload)))).status).toBe(401);
    const ok = await send(githubSignature(signing, Buffer.from(payload)));
    expect(ok.status, ok.body).toBe(200);

    const cleared = await w.call(omar, 'DELETE', `/api/webhooks/${m.id}/signing-secret`);
    expect(cleared.status).toBe(200);
    expect((await send()).status).toBe(200);
  });
});

describe('the test message', () => {
  it('posts a note as the webhook so a lead can see it works', async () => {
    const m = await make('Tester');
    const res = await w.call<{ messageId: string }>(omar, 'POST', `/api/webhooks/${m.id}/test`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const msg = (await messages()).find((x) => x.id === res.body.messageId)!;
    expect(msg.authorId).toBe(await authorOf(m.id));
    expect(msg.body).toContain('Test message');
    expect((await w.call(nadia, 'POST', `/api/webhooks/${m.id}/test`)).status).not.toBe(200);
  });
});

describe('the stranger lock (PLAN D5)', () => {
  it('30 calls with no live webhook lock the address for failing calls only; a call with the right secret still posts', async () => {
    const good = await make('Shared sender');
    const stale = await make('Rotated away');
    expect((await w.call(omar, 'DELETE', `/api/webhooks/${stale.id}`)).status).toBe(200);
    // a busy sender still posting to a revoked address (30 in a row), from the address a good sender shares
    // (earlier tests in this file already counted a few strangers from the same test address)
    const refused: number[] = [];
    for (let i = 0; i < 30; i++) refused.push((await hit(stale.path, { text: `stale ${i}` })).status);
    expect(refused[0]).toBe(404);
    expect(refused).toContain(429);
    const locked = await hit(stale.path, { text: 'stale again' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(4 * 60);
    // the good webhook on the same address is not shut out
    const ok = await hit(good.path, { text: 'still works' });
    expect(ok.status, ok.body).toBe(200);
    expect((await messages()).some((m) => m.body.includes('still works'))).toBe(true);
  });
});
