import { CreateProviderHookResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { buildWebhook, type Tamper, type WebhookProvider } from '../../../../tools/fake-saas/src/providers/sender.ts';

// The public door of the work-app endpoints, end to end against the real server: a lead makes an address, a stand-in app (tools/fake-saas senders) calls it. Proves the acceptance of
// P16-10: one good delivery is one stored event and one announcement; a second delivery, a replay, a tampered call and a stale call add none.

const { omar } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: World;
let channelId: string;
let seq = 0;

beforeAll(async () => {
  w = await createWorld({ limiter: relaxedRateLimiter() }); // many endpoints in a minute: the file is not about the maker's limit
  await ensureChannels(w);
  channelId = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});
// a channel holds 20 integrations: each test starts from none of ours
afterEach(async () => {
  await w.system(async (tx) => void (await tx.query("UPDATE app.webhooks SET revoked_at = now() WHERE kind = 'provider' AND revoked_at IS NULL")));
});

interface Made {
  id: string;
  url: string;
  secret: string;
  provider: WebhookProvider;
}
const PASTED = new Set<WebhookProvider>(['zendesk', 'intercom', 'hubspot']);
/** Makes an endpoint as the lead. Pasted-secret providers get a secret of the test's choosing, the others the one we made. */
async function make(provider: WebhookProvider, extra: { eventFilter?: string[]; slug?: string } = {}): Promise<Made> {
  seq += 1;
  const pasted = PASTED.has(provider) ? `pasted-secret-${provider}-${seq}-0123456789` : undefined;
  const res = await w.call(omar, 'POST', `/api/channels/${channelId}/provider-hooks`, {
    provider,
    slug: extra.slug ?? `${provider}-door-${seq}`,
    ...(extra.eventFilter ? { eventFilter: extra.eventFilter } : {}),
    ...(pasted ? { signingSecret: pasted } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const made = CreateProviderHookResponse.parse(res.body);
  // Asana makes its own secret in the handshake: the test plays the app and picks one
  const secret = pasted ?? made.signingSecret ?? (provider === 'asana' ? 'asana-hook-secret-0123456789' : null);
  if (!secret) throw new Error('no signing secret');
  return { id: made.endpoint.id, url: `http://localhost:3000/hooks/apps/${made.endpoint.id}`, secret, provider };
}

interface Sent {
  status: number;
  json: Record<string, unknown> | null;
  headers: Headers;
}
/** Builds a signed call with the stand-in and posts it to the real server (the signed address is the public one, the call goes to the server's own port). */
async function send(hook: Made, kind: string, o: { tamper?: Tamper; now?: Date; deliveryId?: string; body?: string; padBytes?: number; headers?: Record<string, string>; title?: string } = {}): Promise<Sent> {
  const call = buildWebhook({
    provider: hook.provider,
    url: hook.url,
    secret: hook.secret,
    kind,
    ...(o.tamper ? { tamper: o.tamper } : {}),
    now: o.now ?? new Date(),
    ...(o.deliveryId ? { deliveryId: o.deliveryId } : {}),
    ...(o.body !== undefined ? { body: o.body } : {}),
    ...(o.padBytes ? { padBytes: o.padBytes } : {}),
    ...(o.title ? { title: o.title } : {}),
  });
  return post(hook.id, call.body, { ...call.headers, ...o.headers });
}
async function post(id: string, body: string, headers: Record<string, string>): Promise<Sent> {
  const res = await fetch(`${w.server.url}/hooks/apps/${id}`, { method: 'POST', headers, body });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}
const storedCount = (id: string): Promise<number> =>
  w.system(async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.webhook_provider_events WHERE webhook_id = $1', [id])).rows[0]!.n));
const announced = (id: string): Promise<number> =>
  w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.events WHERE type = 'webhooks.provider_event.received' AND payload->>'webhookId' = $1", [id])).rows[0]!.n));
const refusals = (id: string, reason: string): Promise<{ count: number }[]> =>
  w.system(async (tx) =>
    (await tx.query<{ payload: { count: number } }>("SELECT payload FROM app.events WHERE type = 'webhooks.provider_event.refused' AND payload->>'webhookId' = $1 AND payload->>'reason' = $2 ORDER BY id", [id, reason])).rows.map((r) => r.payload),
  );

describe('the door: a good delivery', () => {
  it('stores one event and announces it with ids only', async () => {
    const hook = await make('zendesk');
    const r = await send(hook, 'ticket.created', { title: 'Printer on fire' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const rows = await w.system(async (tx) => (await tx.query<{ id: string; kind: string; title: string; provider: string }>('SELECT id, kind, title, provider FROM app.webhook_provider_events WHERE webhook_id = $1', [hook.id])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ticket.created', title: 'Printer on fire', provider: 'zendesk' });
    const events = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'webhooks.provider_event.received' AND payload->>'webhookId' = $1", [hook.id])).rows);
    expect(events).toHaveLength(1);
    const p = events[0]!.payload;
    expect(p['eventId']).toBe(rows[0]!.id);
    expect(p['kind']).toBe('ticket.created');
    expect(JSON.stringify(p)).not.toContain('Printer on fire'); // ids, not the app's words
    const list = await w.call(omar, 'GET', `/api/channels/${channelId}/provider-hooks`);
    const mine = (list.body as { endpoints: { id: string; lastReceivedAt: string | null }[] }).endpoints.find((e) => e.id === hook.id);
    expect(mine?.lastReceivedAt).not.toBeNull();
  });

  it('takes a delivery of every provider the stand-in can sign', async () => {
    for (const [provider, kind] of [
      ['github', 'issue.created'],
      ['gitlab', 'issue.created'],
      ['jira', 'issue.created'],
      ['linear', 'issue.created'],
      ['intercom', 'conversation.created'],
      ['hubspot', 'ticket.created'],
      ['asana', 'task.created'],
    ] as const) {
      const hook = await make(provider);
      if (provider === 'asana') {
        const shake = await post(hook.id, '{}', { 'x-hook-secret': hook.secret, 'content-type': 'application/json' });
        expect(shake.status).toBe(200);
      }
      const r = await send(hook, kind);
      expect(r.status, provider).toBe(200);
      expect(await storedCount(hook.id), provider).toBe(1);
    }
  });

  it('takes a generic delivery signed with the secret we made', async () => {
    const hook = await make('generic');
    const r = await send(hook, 'deploy.finished');
    expect(r.status).toBe(200);
    expect(await storedCount(hook.id)).toBe(1);
  });
});

describe('the door: nothing extra from a repeat, a replay, a tampered or a stale call', () => {
  it('a second delivery of the same id, and a replay of the same body with another id, add nothing', async () => {
    const hook = await make('github');
    const id = crypto.randomUUID();
    const now = new Date();
    expect((await send(hook, 'issue.created', { deliveryId: id, now })).status).toBe(200);
    const again = await send(hook, 'issue.created', { deliveryId: id, now });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, duplicate: true });
    // the same signed body with a new delivery id in the (unsigned) header
    const call = buildWebhook({ provider: 'github', url: hook.url, secret: hook.secret, kind: 'issue.created', now, deliveryId: id });
    const replay = await post(hook.id, call.body, { ...call.headers, 'x-github-delivery': crypto.randomUUID() });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ok: true, duplicate: true });
    expect(await storedCount(hook.id)).toBe(1);
    expect(await announced(hook.id)).toBe(1);
  });

  it('the stand-in replay (two identical calls) is one event', async () => {
    const hook = await make('zendesk');
    const call = buildWebhook({ provider: 'zendesk', url: hook.url, secret: hook.secret, kind: 'ticket.created', tamper: 'replay' });
    expect(call.repeat).toBe(2);
    const a = await post(hook.id, call.body, call.headers);
    const b = await post(hook.id, call.body, call.headers);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.json).toMatchObject({ duplicate: true });
    expect(await storedCount(hook.id)).toBe(1);
  });

  it.each(['signature', 'body', 'unsigned'] as const)('a call tampered by %s answers 401 and changes nothing', async (tamper) => {
    const hook = await make('zendesk');
    const r = await send(hook, 'ticket.created', { tamper });
    expect(r.status).toBe(401);
    expect(await storedCount(hook.id)).toBe(0);
    expect(await announced(hook.id)).toBe(0);
  });

  it('a stale call answers 401 and changes nothing', async () => {
    for (const provider of ['zendesk', 'hubspot', 'github', 'generic'] as const) {
      const hook = await make(provider);
      const r = await send(hook, provider === 'generic' ? 'deploy.finished' : provider === 'hubspot' || provider === 'zendesk' ? 'ticket.created' : 'issue.created', { tamper: 'stale' });
      expect(r.status, provider).toBe(401);
      expect(await storedCount(hook.id), provider).toBe(0);
    }
  });

  it('a pasted-secret endpoint without a secret yet refuses every call', async () => {
    seq += 1;
    const res = await w.call(omar, 'POST', `/api/channels/${channelId}/provider-hooks`, { provider: 'zendesk', slug: `zendesk-nosecret-${seq}` });
    expect(res.status).toBe(201);
    const made = CreateProviderHookResponse.parse(res.body);
    expect(made.endpoint.hasSecret).toBe(false);
    const hook: Made = { id: made.endpoint.id, url: `http://localhost:3000/hooks/apps/${made.endpoint.id}`, secret: 'a-secret-the-door-has-not-got', provider: 'zendesk' };
    expect((await send(hook, 'ticket.created')).status).toBe(401);
    expect(await storedCount(hook.id)).toBe(0);
  });

  it('HubSpot is signed over the public address: a call signed for another address is refused', async () => {
    const hook = await make('hubspot');
    const wrong = buildWebhook({ provider: 'hubspot', url: 'https://elsewhere.example/hooks/apps/' + hook.id, secret: hook.secret, kind: 'ticket.created' });
    expect((await post(hook.id, wrong.body, wrong.headers)).status).toBe(401);
    expect((await send(hook, 'ticket.created')).status).toBe(200);
  });
});

describe('the door: shape of the call', () => {
  it('refuses a body over 1 MB with 413 and keeps nothing', async () => {
    const hook = await make('github');
    const r = await send(hook, 'issue.created', { padBytes: 1024 * 1024 + 10 });
    expect(r.status).toBe(413);
    expect(await storedCount(hook.id)).toBe(0);
  });

  it('answers a body that is not JSON (but is signed) with 400', async () => {
    const hook = await make('github');
    const r = await send(hook, 'issue.created', { body: 'this is not json' });
    expect(r.status).toBe(400);
    expect(await storedCount(hook.id)).toBe(0);
  });

  it('an unknown id, a revoked id and a badly shaped id answer the same 404', async () => {
    const hook = await make('github');
    const call = buildWebhook({ provider: 'github', url: hook.url, secret: hook.secret, kind: 'issue.created' });
    const revoke = await w.call(omar, 'DELETE', `/api/provider-hooks/${hook.id}`);
    expect(revoke.status).toBe(200);
    const revoked = await post(hook.id, call.body, call.headers);
    const unknown = await post(crypto.randomUUID(), call.body, call.headers);
    const shaped = await post('not-an-id', call.body, call.headers);
    expect([revoked.status, unknown.status, shaped.status]).toEqual([404, 404, 404]);
    expect(await storedCount(hook.id)).toBe(0);
    const text = async (id: string): Promise<string> => (await fetch(`${w.server.url}/hooks/apps/${id}`, { method: 'POST', headers: call.headers, body: call.body })).text();
    const [a, b] = [await text(hook.id), await text(crypto.randomUUID())];
    expect(a).toBe(b);
  });

  it('a plain webhook (the other kind) is not reachable through this door', async () => {
    const made = await w.call<{ webhook: { id: string } }>(omar, 'POST', `/api/channels/${channelId}/webhooks`, { name: 'plain one' });
    expect(made.status).toBe(201);
    const r = await post(made.body.webhook.id, '{}', { 'content-type': 'application/json' });
    expect(r.status).toBe(404);
  });
});

describe('the door: what the endpoint wants', () => {
  it('an event the platform does not use answers 202 and is forgotten', async () => {
    const hook = await make('github');
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const r = await send(hook, 'issue.created', { body, headers: { 'x-github-event': 'ping' } });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ ignored: true });
    expect(await storedCount(hook.id)).toBe(0);
  });

  it('the event filter keeps out kinds it does not name, and takes a pattern', async () => {
    const hook = await make('zendesk', { eventFilter: ['ticket.created'] });
    const out = await send(hook, 'ticket.status_changed');
    expect(out.status).toBe(202);
    expect(await storedCount(hook.id)).toBe(0);
    expect((await send(hook, 'ticket.created')).status).toBe(200);
    expect(await storedCount(hook.id)).toBe(1);

    const wide = await make('zendesk', { eventFilter: ['ticket.*'] });
    expect((await send(wide, 'ticket.status_changed')).status).toBe(200);
    expect((await send(wide, 'ticket.created')).status).toBe(200);
    expect(await storedCount(wide.id)).toBe(2);
  });
});

describe('the door: Asana handshake', () => {
  it('echoes the secret, keeps it once, and takes signed events after', async () => {
    const hook = await make('asana');
    const shake = await post(hook.id, '{}', { 'x-hook-secret': hook.secret, 'content-type': 'application/json' });
    expect(shake.status).toBe(200);
    expect(shake.headers.get('x-hook-secret')).toBe(hook.secret);
    expect((await send(hook, 'task.created')).status).toBe(200);
    // a second handshake with another secret is not taken as one: it is an unsigned call
    const second = await post(hook.id, '{}', { 'x-hook-secret': 'another-secret-from-an-attacker', 'content-type': 'application/json' });
    expect(second.status).toBe(401);
    expect(second.headers.get('x-hook-secret')).toBeNull();
    // and the first secret still verifies
    expect((await send(hook, 'task.changed')).status).toBe(200);
    expect(await storedCount(hook.id)).toBe(2);
  });
});

describe('the door: limits and the record of refusals', () => {
  it('an endpoint takes 120 calls a minute, then answers 429', async () => {
    const hook = await make('github');
    const statuses = new Map<number, number>();
    for (let i = 0; i < 125; i++) {
      const r = await post(hook.id, '{}', { 'content-type': 'application/json' });
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }
    expect(statuses.get(401)).toBe(120);
    expect(statuses.get(429)).toBe(5);
  }, 120_000);

  it('records a refusal once a minute with a count', async () => {
    const hook = await make('zendesk');
    for (let i = 0; i < 6; i++) expect((await send(hook, 'ticket.created', { tamper: 'signature' })).status).toBe(401);
    const lines = await refusals(hook.id, 'bad_signature');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.count).toBe(1);
  });

  it('records a repeat as a "replayed" refusal, not a second event', async () => {
    const hook = await make('github');
    const id = crypto.randomUUID();
    const now = new Date();
    await send(hook, 'issue.created', { deliveryId: id, now });
    await send(hook, 'issue.created', { deliveryId: id, now });
    expect(await refusals(hook.id, 'replayed')).toHaveLength(1);
    expect(await announced(hook.id)).toBe(1);
  });

  it('does not keep the signing secret anywhere readable', async () => {
    const hook = await make('github');
    const rows = await w.system(async (tx) => (await tx.query('SELECT to_jsonb(p) AS p FROM app.webhook_provider p WHERE webhook_id = $1', [hook.id])).rows);
    expect(JSON.stringify(rows)).not.toContain(hook.secret);
    const list = await w.call(omar, 'GET', `/api/channels/${channelId}/provider-hooks`);
    expect(JSON.stringify(list.body)).not.toContain(hook.secret);
  });
});

describe('from the delivery to the bot (the acceptance of P16-10)', () => {
  const madeBots: string[] = [];
  afterAll(async () => {
    // the bots go again, so a second run of the file starts clean
    await w.system(async (tx) => {
      for (const id of madeBots) {
        await tx.query("DELETE FROM app.team_members WHERE actor_id IN (SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1)", [id]);
        await tx.query("DELETE FROM app.actors WHERE kind = 'bot' AND ref_id = $1", [id]);
        await tx.query('DELETE FROM app.bots WHERE id = $1', [id]);
      }
    }).catch(() => undefined);
  });
  /** A bot of the Engineering team with these triggers, as the loader would leave it (the loader itself is not what is tested here). */
  async function bot(slug: string, triggers: unknown[]): Promise<string> {
    return w.system(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers)
           SELECT t.workspace_id, t.id, $1, $1, '', 'agent', 'hermes', 'team', repeat('a', 64), 'active', $2::jsonb FROM app.teams t WHERE t.slug = 'engineering' RETURNING id`,
          [slug, JSON.stringify(triggers)],
        )
      ).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (workspace_id, kind, ref_id) SELECT workspace_id, 'bot', id FROM app.bots WHERE id = $1 RETURNING id`, [id])).rows[0]!.id;
      // a bot posts where its team does
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT b.team_id, $2, b.workspace_id, 'member' FROM app.bots b WHERE b.id = $1`, [id, actor]);
      madeBots.push(id);
      return id;
    });
  }
  const runJobs = (botId: string): Promise<number> =>
    w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1", [`runtime-hermes:${botId}:webhook:%`])).rows[0]!.n));

  it('one ticket.created is one run of the bot that listens, none of a bot that does not; repeats, replays, tampered and stale calls add none', async () => {
    const listener = await bot('support-responder', [{ type: 'webhook', connection: 'zendesk-accept', event: 'ticket.created' }]);
    const deaf = await bot('no-trigger-bot', [{ type: 'mention' }]);
    const hook = await make('zendesk', { slug: 'zendesk-accept' });
    const id = crypto.randomUUID();
    const now = new Date();
    expect((await send(hook, 'ticket.created', { deliveryId: id, now, title: 'Printer on fire' })).status).toBe(200);
    await eventually(async () => (await runJobs(listener)) === 1, 30_000, 'the bot’s run to be queued');

    // the same delivery again, the same signed body under another id, a tampered call, an unsigned one and a stale one
    expect((await send(hook, 'ticket.created', { deliveryId: id, now, title: 'Printer on fire' })).status).toBe(200);
    const call = buildWebhook({ provider: 'zendesk', url: hook.url, secret: hook.secret, kind: 'ticket.created', now, deliveryId: id, title: 'Printer on fire' });
    expect((await post(hook.id, call.body, call.headers)).status).toBe(200);
    expect((await send(hook, 'ticket.created', { tamper: 'signature' })).status).toBe(401);
    expect((await send(hook, 'ticket.created', { tamper: 'body' })).status).toBe(401);
    expect((await send(hook, 'ticket.created', { tamper: 'stale' })).status).toBe(401);
    // an event the bot did not ask for is stored but starts nothing
    expect((await send(hook, 'ticket.status_changed')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await runJobs(listener)).toBe(1);
    expect(await runJobs(deaf)).toBe(0);
    expect(await storedCount(hook.id)).toBe(2);
    const payload = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1", [`runtime-hermes:${listener}:webhook:%`])).rows[0]!.payload);
    expect(payload).toMatchObject({ trigger: 'webhook', askerActorId: null, replyRootId: null, channelId });
    expect(String(payload['prompt'])).toContain('title: Printer on fire');
  });
});
