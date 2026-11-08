import { CreateProviderHookResponse, ListConnectorHealthResponse, ListProviderHooksResponse, RotateProviderHookResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { buildWebhook } from '../../../../tools/fake-saas/src/providers/sender.ts';

// The management routes of the work-app addresses (P16-10): who may make, change and switch off an address, what is shown once, and what the secret does.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: World;
let channelId: string;
let seq = 0;

beforeAll(async () => {
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  channelId = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});
afterEach(async () => {
  await w.system(async (tx) => void (await tx.query("UPDATE app.webhooks SET revoked_at = now() WHERE kind = 'provider' AND revoked_at IS NULL")));
});

const slug = (p: string): string => `${p}-r${(seq += 1)}`;
const path = (id: string): string => `/api/provider-hooks/${id}`;
const sealedCount = (): Promise<number> => w.system(async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.webhook_provider WHERE signing_secret_id IS NOT NULL')).rows[0]!.n));
async function post(body: Record<string, unknown>, who = omar) {
  return w.call(who, 'POST', `/api/channels/${channelId}/provider-hooks`, body);
}

describe('making an address', () => {
  it('a lead makes one; a generated secret is shown once and never listed', async () => {
    const res = await post({ provider: 'github', slug: slug('github'), eventFilter: ['issue.created'] });
    expect(res.status).toBe(201);
    const made = CreateProviderHookResponse.parse(res.body);
    expect(made.signingSecret).toMatch(/^.{32,}$/);
    expect(made.endpoint).toMatchObject({ provider: 'github', secretSource: 'generated', hasSecret: true, channelId, eventFilter: ['issue.created'], lastReceivedAt: null });
    expect(made.endpoint.path).toBe(`/hooks/apps/${made.endpoint.id}`);
    const list = await w.call(omar, 'GET', `/api/channels/${channelId}/provider-hooks`);
    expect(list.status).toBe(200);
    expect(ListProviderHooksResponse.parse(list.body).endpoints.map((e) => e.id)).toContain(made.endpoint.id);
    expect(JSON.stringify(list.body)).not.toContain(made.signingSecret!);
  });

  it('a pasted secret is not given back; a pasted-secret app can be made without one and given it later', async () => {
    const pasted = 'my-zendesk-secret-123456';
    const withSecret = CreateProviderHookResponse.parse((await post({ provider: 'zendesk', slug: slug('zd'), signingSecret: pasted })).body);
    expect(withSecret).toMatchObject({ signingSecret: null, endpoint: { secretSource: 'pasted', hasSecret: true } });

    const without = CreateProviderHookResponse.parse((await post({ provider: 'intercom', slug: slug('ic') })).body);
    expect(without).toMatchObject({ signingSecret: null, endpoint: { secretSource: 'pasted', hasSecret: false } });
    const put = await w.call(omar, 'PUT', `${path(without.endpoint.id)}/signing-secret`, { signingSecret: 'client-secret-from-intercom' });
    expect(put.status).toBe(200);
    expect((put.body as { endpoint: { hasSecret: boolean } }).endpoint.hasSecret).toBe(true);
    // a secret that is too short is refused
    expect((await w.call(omar, 'PUT', `${path(without.endpoint.id)}/signing-secret`, { signingSecret: 'short' })).status).toBe(400);
  });

  it('Asana makes its own secret: none given and none pasted', async () => {
    const made = CreateProviderHookResponse.parse((await post({ provider: 'asana', slug: slug('asana') })).body);
    expect(made).toMatchObject({ signingSecret: null, endpoint: { hasSecret: false } });
    expect((await post({ provider: 'asana', slug: slug('asana'), signingSecret: 'something-long-enough' })).status).toBe(400);
    expect((await w.call(omar, 'PUT', `${path(made.endpoint.id)}/signing-secret`, { signingSecret: 'something-long-enough' })).status).toBe(409);
    expect((await w.call(omar, 'POST', `${path(made.endpoint.id)}/rotate`)).status).toBe(409);
  });

  it('a person who is not a lead of the team or an admin may neither see nor make one', async () => {
    expect((await post({ provider: 'github', slug: slug('gh') }, nadia)).status).toBe(403);
    expect((await w.call(nadia, 'GET', `/api/channels/${channelId}/provider-hooks`)).status).toBe(403);
    // and someone of another team cannot even tell the channel exists
    const other = await w.call(sameera, 'POST', `/api/channels/${channelId}/provider-hooks`, { provider: 'github', slug: slug('gh') });
    expect([403, 404]).toContain(other.status);
  });

  it('a short name already used in the team is a 409; the same name in another team is fine', async () => {
    const name = slug('dup');
    expect((await post({ provider: 'github', slug: name })).status).toBe(201);
    const again = await post({ provider: 'gitlab', slug: name, name: 'Second' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/short name/);
  });

  it('refuses a bad short name or a bad event filter', async () => {
    expect((await post({ provider: 'github', slug: 'Not Valid!' })).status).toBe(400);
    expect((await post({ provider: 'github', slug: slug('gh'), eventFilter: ['No Good'] })).status).toBe(400);
    expect((await post({ provider: 'nope', slug: slug('gh') })).status).toBe(400);
  });

  it('a name over 60 characters is refused', async () => {
    expect((await post({ provider: 'github', slug: slug('gh'), name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('a channel holds at most 20 integrations', async () => {
    for (let i = 0; i < 20; i++) expect((await post({ provider: 'generic', slug: slug('cap') })).status, `address ${i + 1}`).toBe(201);
    const over = await post({ provider: 'generic', slug: slug('cap') });
    expect(over.status).toBe(409);
  });
});

describe('changing, rotating and switching off', () => {
  it('changes the name and the event filter', async () => {
    const made = CreateProviderHookResponse.parse((await post({ provider: 'zendesk', slug: slug('zd'), signingSecret: 'my-zendesk-secret-123456' })).body);
    const res = await w.call(omar, 'PATCH', path(made.endpoint.id), { name: 'Support desk', eventFilter: ['ticket.*'] });
    expect(res.status).toBe(200);
    expect((res.body as { endpoint: { name: string; eventFilter: string[] } }).endpoint).toMatchObject({ name: 'Support desk', eventFilter: ['ticket.*'] });
    expect((await w.call(omar, 'PATCH', path(made.endpoint.id), {})).status).toBe(400);
    expect((await w.call(nadia, 'PATCH', path(made.endpoint.id), { name: 'Mine now' })).status).toBe(404);
  });

  it('a new signing secret stops the old one at once', async () => {
    const made = CreateProviderHookResponse.parse((await post({ provider: 'generic', slug: slug('gen') })).body);
    const url = `http://localhost:3000/hooks/apps/${made.endpoint.id}`;
    const call = (secret: string) => buildWebhook({ provider: 'generic', url, secret, kind: 'deploy.finished' });
    const send = async (c: ReturnType<typeof call>) => (await fetch(`${w.server.url}/hooks/apps/${made.endpoint.id}`, { method: 'POST', headers: c.headers, body: c.body })).status;
    expect(await send(call(made.signingSecret!))).toBe(200);
    const rotated = RotateProviderHookResponse.parse((await w.call(omar, 'POST', `${path(made.endpoint.id)}/rotate`)).body);
    expect(rotated.signingSecret).not.toBe(made.signingSecret);
    expect(rotated.endpoint.rotatedAt).not.toBeNull();
    expect(await send(call(made.signingSecret!))).toBe(401);
    expect(await send(call(rotated.signingSecret))).toBe(200);
  });

  it('an app that gives you the secret cannot be rotated here', async () => {
    const made = CreateProviderHookResponse.parse((await post({ provider: 'hubspot', slug: slug('hs') })).body);
    expect((await w.call(omar, 'POST', `${path(made.endpoint.id)}/rotate`)).status).toBe(409);
  });

  it('switching off removes the address, its sealed secret and the door', async () => {
    const before = await sealedCount();
    const made = CreateProviderHookResponse.parse((await post({ provider: 'github', slug: slug('gh') })).body);
    expect(await sealedCount()).toBe(before + 1);
    const call = buildWebhook({ provider: 'github', url: `http://localhost:3000/hooks/apps/${made.endpoint.id}`, secret: made.signingSecret!, kind: 'issue.created' });
    expect((await w.call(nadia, 'DELETE', path(made.endpoint.id))).status).toBe(404);
    const res = await w.call(omar, 'DELETE', path(made.endpoint.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });
    expect(await sealedCount()).toBe(before);
    expect((await fetch(`${w.server.url}/hooks/apps/${made.endpoint.id}`, { method: 'POST', headers: call.headers, body: call.body })).status).toBe(404);
    const list = ListProviderHooksResponse.parse((await w.call(omar, 'GET', `/api/channels/${channelId}/provider-hooks`)).body);
    expect(list.endpoints.map((e) => e.id)).not.toContain(made.endpoint.id);
    // a short name is free again once the address is off
    expect((await post({ provider: 'github', slug: made.endpoint.slug })).status).toBe(201);
  });

  it('every change is announced with ids only', async () => {
    const made = CreateProviderHookResponse.parse((await post({ provider: 'github', slug: slug('gh') })).body);
    await w.call(omar, 'POST', `${path(made.endpoint.id)}/rotate`);
    await w.call(omar, 'DELETE', path(made.endpoint.id));
    const rows = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'webhooks.provider_endpoint.changed' AND payload->>'webhookId' = $1 ORDER BY id", [made.endpoint.id])).rows);
    expect(rows.map((r) => r.payload['change'])).toEqual(['created', 'rotated', 'revoked']);
    expect(JSON.stringify(rows)).not.toContain(made.signingSecret!);
  });
});

describe('the admin health view', () => {
  it('is for a workspace admin only and counts addresses without a secret', async () => {
    CreateProviderHookResponse.parse((await post({ provider: 'intercom', slug: slug('ic') })).body);
    expect((await w.call(nadia, 'GET', '/api/admin/webhooks/provider-health')).status).toBe(403);
    const res = await w.call(omar, 'GET', '/api/admin/webhooks/provider-health');
    expect(res.status).toBe(200);
    const row = ListConnectorHealthResponse.parse(res.body).rows.find((r) => r.connector === 'intercom');
    expect(row).toMatchObject({ area: 'webhooks', shared: 1, needsReconnect: 1 });
    expect(row?.problem).toMatch(/no signing secret/);
  });
});
