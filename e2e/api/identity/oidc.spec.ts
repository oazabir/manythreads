import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { startFakeOidc, type FakeLoginClaims, type FakeOidc } from '@manythreads/test-utils';
import { PERSONA_EMAILS, TEST_AUTH_TOKEN } from '../support/api.ts';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes data (channels, messages, ...): its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();

/**
 * OpenID Connect sign-in through the HTTP API, against the in-process fake issuer (the container in tools/mock-oidc
 * serves the browser specs). The provider is an any-OIDC one whose issuer is the fake's loopback URL; Google and
 * Microsoft rules are covered by the plugin's integration tests. Serial: the tests share one provider.
 */
test.describe.configure({ mode: 'serial' });

const CLIENT_ID = 'e2e-any-client';
const CLIENT_SECRET = `e2e-secret-${randomUUID()}`;

let fake: FakeOidc;
let admin: APIRequestContext;
let providerId = '';
const bodies: string[] = [];

async function signedIn(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string, email: string): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post('/api/test/session', { data: { email }, headers: { 'x-test-auth': TEST_AUTH_TOKEN } });
  expect(res.status(), `test sign-in as ${email}`).toBe(200);
  return ctx;
}

/** Writes with the CSRF header the way the web client does. */
async function csrf(ctx: APIRequestContext): Promise<Record<string, string>> {
  const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_csrf');
  return cookie ? { 'x-csrf-token': cookie.value } : {};
}

interface ProviderJson {
  id: string;
  enabled: boolean;
  disabledReason: string | null;
  hasSecret: boolean;
}

async function adminCall(
  method: 'post' | 'patch' | 'delete',
  path: string,
  data?: unknown,
): Promise<{ status: number; json: { provider: ProviderJson } }> {
  const res = await admin[method](path, { data, headers: await csrf(admin) });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status(), json: text ? (JSON.parse(text) as { provider: ProviderJson }) : ({} as { provider: ProviderJson }) };
}

/** start -> provider -> callback in a fresh browser context; returns where the callback sent the browser. */
async function browse(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
  login: FakeLoginClaims,
  options: { returnTo?: string; mangleState?: boolean; fake?: Parameters<FakeOidc['nextLogin']>[2] } = {},
): Promise<{ location: string; ctx: APIRequestContext }> {
  const ctx = await playwright.request.newContext({ baseURL });
  const q = options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : '';
  const start = await ctx.get(`/api/auth/oidc/${providerId}/start${q}`, { maxRedirects: 0 });
  expect(start.status()).toBe(302);
  const authorize = start.headers()['location'] as string;
  expect(authorize.startsWith(fake.baseUrl)).toBe(true);
  fake.nextLogin('any', login, options.fake);
  const back = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(back.headers.get('location') as string);
  if (options.mangleState) callback.searchParams.set('state', 'not-the-state');
  const res = await ctx.get(`${callback.pathname}${callback.search}`, { maxRedirects: 0 });
  return { location: res.headers()['location'] ?? '', ctx };
}

test.beforeAll(async ({ playwright }) => {
  fake = await startFakeOidc();
  fake.addClient('any', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  fake.addClient('down', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  admin = await signedIn(playwright, (await iso.start()).origin, PERSONA_EMAILS.omar);
});

test.afterAll(async () => {
  // the provider goes with the file's own stack; nothing to clean up on a shared server
  await admin?.dispose();
  await fake?.close();
});

test('only workspace admins reach the provider API', async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL: baseURL as string });
  expect((await anon.get('/api/auth/oidc/providers')).status()).toBe(401);
  const nadia = await signedIn(playwright, baseURL as string, PERSONA_EMAILS.nadia);
  expect((await nadia.get('/api/auth/oidc/providers')).status()).toBe(403);
  const create = await nadia.post('/api/auth/oidc/providers', {
    data: { kind: 'oidc', issuer: fake.issuer('any'), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    headers: await csrf(nadia),
  });
  expect(create.status()).toBe(403);
});

test('discovery runs on save; a failure leaves the provider disabled with the reason', async () => {
  fake.failDiscovery('down');
  const bad = await adminCall('post', '/api/auth/oidc/providers', {
    kind: 'oidc', issuer: fake.issuer('down'), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, label: 'Down SSO',
  });
  expect(bad.status).toBe(200);
  expect(bad.json.provider).toMatchObject({ enabled: false, hasSecret: true });
  expect(bad.json.provider.disabledReason).toContain('discovery');
  await adminCall('delete', `/api/auth/oidc/providers/${bad.json.provider.id}`);

  const good = await adminCall('post', '/api/auth/oidc/providers', {
    kind: 'oidc', issuer: fake.issuer('any'), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, label: 'Acme SSO', allowedDomains: ['kahf.example'],
  });
  expect(good.status).toBe(200);
  expect(good.json.provider).toMatchObject({ kind: 'oidc', enabled: true, disabledReason: null, hasSecret: true, label: 'Acme SSO' });
  providerId = good.json.provider.id;
});

test('the sign-in screen can list the method, and session discovery shows it', async ({ request }) => {
  const methods = (await (await request.get('/api/auth/oidc/methods')).json()) as { methods: { id: string; label: string; startUrl: string }[] };
  expect(methods.methods).toContainEqual({ id: providerId, kind: 'oidc', label: 'Acme SSO', startUrl: `/api/auth/oidc/${providerId}/start` });
  const session = (await (await request.get('/api/session')).json()) as { methods: { kind: string }[] };
  expect(session.methods.map((m) => m.kind)).toContain('oidc');
});

test('an invited person signs in once, is created once, and lands on the return path', async ({ playwright, baseURL }) => {
  const email = `tariq.${randomUUID().slice(0, 8)}@kahf.example`;
  const invite = await adminCall('post', '/api/invitations', { email, role: 'member' });
  expect(invite.status).toBeLessThan(300);

  const first = await browse(playwright, baseURL as string, { email, email_verified: true, name: 'Tariq', sub: `sub-${email}` }, { returnTo: '/teams' });
  expect(first.location).toBe('/teams');
  const me = (await (await first.ctx.get('/api/session')).json()) as { authenticated: boolean; person: { email: string } };
  expect(me).toMatchObject({ authenticated: true, person: { email } });

  const second = await browse(playwright, baseURL as string, { email, email_verified: true, name: 'Tariq', sub: `sub-${email}` });
  expect(second.location).toBe('/');

  const members = (await (await admin.get('/api/workspace/members')).json()) as { members: { email: string }[] };
  expect(members.members.filter((m) => m.email === email)).toHaveLength(1);
});

test('refusals come back to sign-in with a code: other domain, unknown person, wrong state', async ({ playwright, baseURL }) => {
  const other = await browse(playwright, baseURL as string, { email: 'eve@other.com', email_verified: true, sub: 'eve' });
  expect(other.location).toBe('/sign-in?error=domain_not_allowed');
  expect(((await (await other.ctx.get('/api/session')).json()) as { authenticated: boolean }).authenticated).toBe(false);

  const uninvited = await browse(playwright, baseURL as string, { email: `nobody.${randomUUID().slice(0, 8)}@kahf.example`, email_verified: true, sub: randomUUID() });
  expect(uninvited.location).toBe('/sign-in?error=signup_closed');

  const forged = await browse(playwright, baseURL as string, { email: 'x@kahf.example', email_verified: true, sub: 'x' }, { mangleState: true });
  expect(forged.location).toBe('/sign-in?error=state_invalid');

  const wrongNonce = await browse(playwright, baseURL as string, { email: 'x@kahf.example', email_verified: true, sub: 'x' }, { fake: { nonce: 'attacker' } });
  expect(wrongNonce.location).toBe('/sign-in?error=token_invalid');
});

test('no response ever carried the client secret', async () => {
  expect(bodies.length).toBeGreaterThan(3);
  expect(bodies.some((b) => b.includes(CLIENT_SECRET))).toBe(false);
  const list = await (await admin.get('/api/auth/oidc/providers')).text();
  expect(list).not.toContain(CLIENT_SECRET);
  expect(list).toContain('"hasSecret":true');
});
