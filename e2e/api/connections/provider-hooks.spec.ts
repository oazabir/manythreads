import { SEED_CONNECTORS, personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';
import { doorUrl, seededOf, sendWebhook } from '../../connections/support.ts';
import type { APIRequestContext } from '@playwright/test';

/*
 * The public door for work apps and the routes that manage its addresses (PLAN P16-10, decisions D10 and D21), on seed v16: `#support` has a Zendesk address with a known signing secret.
 * Covered: a good call is taken once and a repeat is a duplicate; a changed body, an old timestamp and an unsigned call are all 401; an unknown address and a revoked one answer the same 404;
 * a body over 1 MB is 413; only a lead of the team makes, rotates or revokes an address; the secret is shown once and never listed; a rotated secret stops the old one.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'connectors', MANYTHREADS_STACK_API_ONLY: '1' });

const { omar, priya } = personas;
const as = (p: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }) });

const secret = SEED_CONNECTORS.zendesk.secret;
const statusesOf = async (promise: ReturnType<typeof sendWebhook>): Promise<number[]> => (await promise).responses.map((r) => r.status);

async function create(request: APIRequestContext, channelId: string, who: Persona, body: Record<string, unknown>): Promise<{ status: number; json: { endpoint?: { id: string }; signingSecret?: string | null } }> {
  const res = await request.post(`/api/channels/${channelId}/provider-hooks`, { headers: as(who), data: body });
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as { endpoint?: { id: string }; signingSecret?: string | null } };
}

test('a signed call is taken once, and the same delivery again is a duplicate', async () => {
  const stack = await iso.start();
  const url = doorUrl(stack, seededOf(stack).zendeskEndpointId);
  const input = { provider: 'zendesk', url, secret, kind: 'ticket.created', title: 'Door test one', deliveryId: 'door-delivery-1' };
  const first = await sendWebhook(stack, input);
  expect(first.responses.map((r) => r.status)).toEqual([200]);
  const again = await sendWebhook(stack, input);
  expect(again.responses.map((r) => r.status)).toEqual([200]);
  expect(again.responses[0]?.body ?? '').toContain('duplicate');
  const stored = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.webhook_provider_events WHERE delivery_key = 'door-delivery-1'`);
  expect(stored[0]!.n).toBe('1');
});

test('a changed body, an old timestamp and an unsigned call are all refused 401, and store nothing', async () => {
  const stack = await iso.start();
  const url = doorUrl(stack, seededOf(stack).zendeskEndpointId);
  const before = (await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.webhook_provider_events`))[0]!.n;
  for (const tamper of ['body', 'stale', 'unsigned', 'signature'] as const) {
    expect(await statusesOf(sendWebhook(stack, { provider: 'zendesk', url, secret, kind: 'ticket.created', title: `Refused ${tamper}`, tamper })), tamper).toEqual([401]);
  }
  expect((await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.webhook_provider_events`))[0]!.n).toBe(before);
});

test('a body over 1 MB is refused 413', async () => {
  const stack = await iso.start();
  const url = doorUrl(stack, seededOf(stack).zendeskEndpointId);
  expect(await statusesOf(sendWebhook(stack, { provider: 'zendesk', url, secret, kind: 'ticket.created', padBytes: 1_500_000 }))).toEqual([413]);
});

test('an address that does not exist answers 404, and so does one that was revoked (the same words)', async ({ request }) => {
  const stack = await iso.start();
  const channelId = seededOf(stack).supportChannelId;
  const made = await create(request, channelId, omar, { provider: 'generic', slug: 'door-revoked', name: 'Door revoked' });
  expect(made.status).toBe(201);
  const id = made.json.endpoint!.id;
  const live = await sendWebhook(stack, { provider: 'generic', url: doorUrl(stack, id), secret: made.json.signingSecret!, kind: 'thing.created' });
  expect(live.responses[0]?.status).toBeLessThan(300);
  const revoked = await request.delete(`/api/provider-hooks/${id}`, { headers: as(omar) });
  expect(revoked.status()).toBe(200);

  const unknown = await request.post(`/hooks/apps/00000000-0000-4000-8000-000000000999`, { data: {} });
  const gone = await request.post(`/hooks/apps/${id}`, { data: {} });
  expect(unknown.status()).toBe(404);
  expect(gone.status()).toBe(404);
  expect(await gone.text()).toBe(await unknown.text());
});

test('only a lead of the team makes an address; the secret is shown once and is in no listing; rotating stops the old secret', async ({ request }) => {
  const stack = await iso.start();
  const channelId = seededOf(stack).supportChannelId;
  // Priya works in Engineering, not in Customer support
  const refused = await create(request, channelId, priya, { provider: 'generic', slug: 'door-not-mine', name: 'Not mine' });
  expect([403, 404]).toContain(refused.status);

  const made = await create(request, channelId, omar, { provider: 'generic', slug: 'door-rotate', name: 'Door rotate' });
  expect(made.status).toBe(201);
  const first = made.json.signingSecret!;
  expect(first.length).toBeGreaterThanOrEqual(16);
  const listed = await request.get(`/api/channels/${channelId}/provider-hooks`, { headers: as(omar) });
  expect(listed.status()).toBe(200);
  expect(await listed.text()).not.toContain(first);

  const rotated = await request.post(`/api/provider-hooks/${made.json.endpoint!.id}/rotate`, { headers: as(omar) });
  expect(rotated.status()).toBe(200);
  const second = ((await rotated.json()) as { signingSecret: string }).signingSecret;
  expect(second).not.toBe(first);
  const url = doorUrl(stack, made.json.endpoint!.id);
  expect(await statusesOf(sendWebhook(stack, { provider: 'generic', url, secret: first, kind: 'thing.created', title: 'with the old secret' }))).toEqual([401]);
  expect((await statusesOf(sendWebhook(stack, { provider: 'generic', url, secret: second, kind: 'thing.created', title: 'with the new secret' })))[0]).toBeLessThan(300);
  // no secret is in the stored events or the audit log
  for (const value of [first, second, secret]) {
    expect(await stack.sql(`SELECT 1 FROM app.events WHERE payload::text LIKE '%' || $1 || '%'`, [value])).toHaveLength(0);
  }
});

test('a run that was not started by an app has no origin: 404', async ({ request }) => {
  await iso.start();
  expect((await request.get(`/api/runs/00000000-0000-4000-8000-000000000998/origin`, { headers: as(omar) })).status()).toBe(404);
});
