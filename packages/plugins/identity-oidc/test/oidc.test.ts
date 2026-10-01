import { withActor, withSystem } from '@manythreads/kernel';
import {
  ErrorEnvelope,
  GetSessionResponse,
  ListOidcMethodsResponse,
  ListOidcProvidersResponse,
  OidcProviderResponse,
  TestOidcProviderResponse,
} from '@manythreads/shared';
import {
  createApiClient,
  createPersonas,
  startFakeOidc,
  startTestServer,
  NADIA,
  OMAR,
  TARIQ,
  TEAM_IDS,
  type ApiClient,
  type FakeLoginClaims,
  type FakeLoginOptions,
  type FakeOidc,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_AUTH_TOKEN = 'test-auth-token-for-oidc-vitest-0123456789';
const TENANT = '9f1c7a64-2b2a-4c0e-8f3c-5a6f1e0c2d11';
const OTHER_TENANT = '11111111-2222-4333-8444-555555555555';
const SECRETS = { google: 'g-client-secret-7f3a91', microsoft: 'm-client-secret-c04b22', any: 'a-client-secret-5d8e60' } as const;

let s: TestServer;
let fake: FakeOidc;
let admin: ApiClient;
/** Every response body and header text the tests saw, to prove that no secret ever shows up in one. */
const seen: string[] = [];
let previousBase: string | undefined;

const sql = <T>(text: string, values: unknown[] = []): Promise<T[]> =>
  withSystem(async (tx) => (await tx.query(text, values)).rows as T[], { pool: s.pools.system });
const one = async <T>(text: string, values: unknown[] = []): Promise<T | undefined> => (await sql<T>(text, values))[0];

/** A browser: follows nothing by itself, keeps cookies of the manythreads origin. */
class Browser {
  readonly jar = new Map<string, string>();
  async nav(url: string): Promise<Response> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), 'user-agent': 'Mozilla/5.0 Chrome/126.0 Safari/537.36' } });
    for (const raw of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = raw.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const [name, value] = [pair.slice(0, eq), pair.slice(eq + 1)];
      if (value === '' || attrs.some((a) => /^max-age=0$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    seen.push(`${res.status} ${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`);
    return res;
  }
  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

interface Run {
  /** The redirect target of the callback. */
  location: string;
  status: number;
  browser: Browser;
  /** The callback URL as the provider sent the browser (on this server). */
  callback: string;
  startLocation: string;
}

/** start -> provider authorize -> callback, like a browser. `login` is what the provider will assert. */
async function signIn(
  providerId: string,
  issuerId: string,
  login: FakeLoginClaims | null,
  options: { returnTo?: string; fake?: FakeLoginOptions; browser?: Browser; tweakCallback?: (url: URL) => void; dropCookie?: boolean } = {},
): Promise<Run> {
  const browser = options.browser ?? new Browser();
  const q = options.returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(options.returnTo)}`;
  const start = await browser.nav(`${s.url}/api/auth/oidc/${providerId}/start${q}`);
  const startLocation = start.headers.get('location') ?? '';
  if (start.status !== 302 || !startLocation.startsWith(fake.baseUrl)) {
    return { location: startLocation, status: start.status, browser, callback: '', startLocation };
  }
  if (login) fake.nextLogin(issuerId, login, options.fake);
  const auth = await fetch(startLocation, { redirect: 'manual' });
  const back = new URL(auth.headers.get('location') ?? '');
  const callback = new URL(`${s.url}${back.pathname}${back.search}`);
  options.tweakCallback?.(callback);
  if (options.dropCookie) browser.jar.delete('manythreads_oidc');
  const cb = await browser.nav(callback.href);
  return { location: cb.headers.get('location') ?? '', status: cb.status, browser, callback: callback.href, startLocation };
}

const google = (email: string, extra: FakeLoginClaims = {}): FakeLoginClaims => ({
  email,
  email_verified: true,
  hd: email.split('@')[1] as string,
  name: email.split('@')[0] as string,
  ...extra,
});

async function post<T>(path: string, body: unknown, client: ApiClient = admin): Promise<{ status: number; body: T }> {
  const res = await client.post(path, body);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, body: JSON.parse(text) as T };
}
async function get<T>(path: string, client: ApiClient = admin): Promise<{ status: number; body: T }> {
  const res = await client.get(path);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, body: JSON.parse(text) as T };
}

let googleId = '';
let microsoftId = '';
let anyId = '';

beforeAll(async () => {
  fake = await startFakeOidc();
  previousBase = process.env['MANYTHREADS_OIDC_MOCK_BASE'];
  process.env['MANYTHREADS_OIDC_MOCK_BASE'] = fake.baseUrl;
  fake.addClient('google', { clientId: 'google-client', clientSecret: SECRETS.google });
  fake.addClient('microsoft', { clientId: 'ms-client', clientSecret: SECRETS.microsoft });
  fake.addClient('any', { clientId: 'any-client', clientSecret: SECRETS.any });
  fake.addClient('broken', { clientId: 'broken-client', clientSecret: 'x' });

  s = await startTestServer({ testAuthToken: TEST_AUTH_TOKEN });
  await createPersonas(s.db);
  admin = createApiClient(s.url);
  expect((await admin.testSignIn(OMAR.email, TEST_AUTH_TOKEN)).status).toBe(200);
}, 120_000);

afterAll(async () => {
  if (previousBase === undefined) delete process.env['MANYTHREADS_OIDC_MOCK_BASE'];
  else process.env['MANYTHREADS_OIDC_MOCK_BASE'] = previousBase;
  await s?.close();
  await fake?.close();
});

describe('provider admin API', () => {
  it('is for workspace admins only', async () => {
    const anonymous = createApiClient(s.url);
    expect((await anonymous.get('/api/auth/oidc/providers')).status).toBe(401);
    const nadia = createApiClient(s.url);
    await nadia.testSignIn(NADIA.email, TEST_AUTH_TOKEN);
    const list = await nadia.get('/api/auth/oidc/providers');
    expect(list.status).toBe(403);
    expect(ErrorEnvelope.parse(await list.json()).error.code).toBe('forbidden');
    const create = await nadia.post('/api/auth/oidc/providers', {
      kind: 'google', clientId: 'x', clientSecret: 'y', allowedDomains: ['kahf.co'],
    });
    expect(create.status).toBe(403);
    expect(await one('SELECT 1 FROM app.auth_providers WHERE kind = $1', ['google'])).toBeUndefined();
  });

  it('validates the request and refuses a Google provider without a domain', async () => {
    const noDomain = await post('/api/auth/oidc/providers', { kind: 'google', clientId: 'g', clientSecret: 's', allowedDomains: [] });
    expect(noDomain.status).toBe(400);
    const badTenant = await post('/api/auth/oidc/providers', { kind: 'microsoft', tenantId: 'common', clientId: 'g', clientSecret: 's' });
    expect(badTenant.status).toBe(400);
    const extra = await post('/api/auth/oidc/providers', { kind: 'oidc', issuer: 'https://idp.example', clientId: 'g', clientSecret: 's', role: 'admin' });
    expect(extra.status).toBe(400);
    const plainHttp = await post('/api/auth/oidc/providers', { kind: 'oidc', issuer: 'http://idp.example', clientId: 'g', clientSecret: 's' });
    expect(plainHttp.status).toBe(400);
  });

  it('creates the three kinds; discovery runs on save and the secret is never returned', async () => {
    const g = await post<OidcProviderResponse>('/api/auth/oidc/providers', {
      kind: 'google', clientId: 'google-client', clientSecret: SECRETS.google, allowedDomains: ['KAHF.co'],
    });
    expect(g.status).toBe(200);
    const gp = OidcProviderResponse.parse(g.body).provider;
    expect(gp).toMatchObject({
      kind: 'google', label: 'Google', clientId: 'google-client', enabled: true, disabledReason: null, hasSecret: true,
      allowedDomains: ['kahf.co'], issuer: fake.issuer('google'),
    });
    expect(gp.callbackUrl).toBe('http://localhost:3000/api/auth/oidc/callback');
    expect(gp.lastTest?.ok).toBe(true);
    googleId = gp.id;

    const m = await post<OidcProviderResponse>('/api/auth/oidc/providers', {
      kind: 'microsoft', tenantId: TENANT.toUpperCase(), clientId: 'ms-client', clientSecret: SECRETS.microsoft, allowedDomains: ['kahf.co'], label: 'Microsoft 365',
    });
    const mp = OidcProviderResponse.parse(m.body).provider;
    expect(mp).toMatchObject({ kind: 'microsoft', label: 'Microsoft 365', tenantId: TENANT, enabled: true, hasSecret: true });
    microsoftId = mp.id;

    const a = await post<OidcProviderResponse>('/api/auth/oidc/providers', {
      kind: 'oidc', issuer: fake.issuer('any'), clientId: 'any-client', clientSecret: SECRETS.any, label: 'Acme SSO',
    });
    const ap = OidcProviderResponse.parse(a.body).provider;
    expect(ap).toMatchObject({ kind: 'oidc', label: 'Acme SSO', issuer: fake.issuer('any'), enabled: true, allowedDomains: [] });
    anyId = ap.id;

    const list = ListOidcProvidersResponse.parse((await get('/api/auth/oidc/providers')).body);
    expect(list.providers.map((p) => p.kind)).toEqual(['google', 'microsoft', 'oidc']);
    for (const p of list.providers) expect(Object.keys(p)).not.toContain('clientSecret');
  });

  it('keeps the secret out of the database rows the API reads, encrypted at rest, and out of events', async () => {
    const row = await one<{ config: unknown; secret_id: string }>('SELECT config, secret_id FROM app.auth_providers WHERE id = $1', [googleId]);
    expect(JSON.stringify(row)).not.toContain(SECRETS.google);
    expect(row?.secret_id).toBeTruthy();
    const secret = await one<{ ciphertext: Buffer; workspace_id: string }>('SELECT ciphertext, workspace_id FROM app.secrets WHERE id = $1', [row?.secret_id]);
    expect(secret?.ciphertext.toString('utf8')).not.toContain(SECRETS.google);
    expect(secret?.workspace_id).toBe(OMAR.workspaceId);
    const events = await sql<{ payload: unknown }>(`SELECT payload FROM app.events WHERE type = 'identity.provider.changed'`);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(events)).not.toContain('client-secret');
  });

  it('tests, disables and enables a provider', async () => {
    const t = TestOidcProviderResponse.parse((await post(`/api/auth/oidc/providers/${googleId}/test`, undefined)).body);
    expect(t.result.ok).toBe(true);
    expect(t.provider.lastTest?.ok).toBe(true);
    const off = OidcProviderResponse.parse((await post(`/api/auth/oidc/providers/${anyId}/disable`, undefined)).body).provider;
    expect(off).toMatchObject({ enabled: false, disabledReason: null });
    const on = OidcProviderResponse.parse((await post(`/api/auth/oidc/providers/${anyId}/enable`, undefined)).body).provider;
    expect(on).toMatchObject({ enabled: true, disabledReason: null });
    expect((await post(`/api/auth/oidc/providers/00000000-0000-7000-8000-000000000000/test`, undefined)).status).toBe(404);
  });

  it('updates a provider without changing or returning the secret', async () => {
    const res = await admin.request('PATCH', `/api/auth/oidc/providers/${googleId}`, { body: { allowedDomains: ['kahf.co', 'kahf.example'], label: 'Kahf Google' } });
    const p = OidcProviderResponse.parse(await res.json()).provider;
    expect(p).toMatchObject({ label: 'Kahf Google', allowedDomains: ['kahf.co', 'kahf.example'], hasSecret: true, enabled: true });
    const bad = await admin.request('PATCH', `/api/auth/oidc/providers/${googleId}`, { body: { tenantId: TENANT } });
    expect(bad.status).toBe(400);
    const bad2 = await admin.request('PATCH', `/api/auth/oidc/providers/${googleId}`, { body: { allowedDomains: [] } });
    expect(bad2.status).toBe(400);
    expect(await one('SELECT 1 FROM app.secrets s JOIN app.auth_providers p ON p.secret_id = s.id WHERE p.id = $1', [googleId])).toBeDefined();
  });

  it('lists the enabled providers for the sign-in screen, and session discovery shows them', async () => {
    const anon = createApiClient(s.url);
    const methods = ListOidcMethodsResponse.parse(await (await anon.get('/api/auth/oidc/methods')).json()).methods;
    expect(methods.map((m) => [m.kind, m.label])).toEqual([['google', 'Kahf Google'], ['microsoft', 'Microsoft 365'], ['oidc', 'Acme SSO']]);
    expect(methods[0]?.startUrl).toBe(`/api/auth/oidc/${googleId}/start`);
    const session = GetSessionResponse.parse(await (await anon.get('/api/session')).json());
    expect(session.methods.map((m) => m.kind)).toEqual(expect.arrayContaining(['google', 'microsoft', 'oidc']));
  });
});

describe('Google: domain and hd', () => {
  it('accepts tariq@kahf.co when sign-up is open, creates the person once and signs in', async () => {
    await sql('UPDATE app.workspaces SET self_signup = true WHERE id = $1', [OMAR.workspaceId]);
    const first = await signIn(googleId, 'google', google('tariq@kahf.co', { sub: 'g-tariq' }), { returnTo: '/teams/engineering' });
    expect(first.status).toBe(302);
    expect(first.location).toBe('/teams/engineering');
    expect(first.browser.jar.get('manythreads_oidc')).toBeUndefined();
    const sessionRes = await fetch(`${s.url}/api/session`, { headers: { cookie: first.browser.cookieHeader() } });
    const session = GetSessionResponse.parse(await sessionRes.json());
    expect(session).toMatchObject({ authenticated: true, person: { email: 'tariq@kahf.co' }, role: 'member' });

    const again = await signIn(googleId, 'google', google('tariq@kahf.co', { sub: 'g-tariq' }));
    expect(again.location).toBe('/');
    expect((await sql('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', ['tariq@kahf.co'])).length).toBe(1);
    expect((await sql('SELECT 1 FROM app.identities WHERE subject = $1', ['g-tariq'])).length).toBe(1);
    const emails = await sql<{ verified_at: Date | null }>('SELECT verified_at FROM app.person_emails WHERE lower(email) = $1', ['tariq@kahf.co']);
    expect(emails[0]?.verified_at).not.toBeNull();
    const events = await sql<{ payload: { createdPerson: boolean; kind: string } }>(
      `SELECT payload FROM app.events WHERE type = 'identity.oidc.signed_in' ORDER BY id`,
    );
    expect(events.map((e) => e.payload.createdPerson)).toEqual([true, false]);
  });

  it('refuses other.com with the sign-in error and creates nothing', async () => {
    const before = (await sql('SELECT 1 FROM app.people')).length;
    const run = await signIn(googleId, 'google', google('mallory@other.com'));
    expect(run.location).toBe('/sign-in?error=domain_not_allowed');
    expect([...run.browser.jar.keys()]).toEqual([]);
    expect((await sql('SELECT 1 FROM app.people')).length).toBe(before);
    const ev = await one<{ payload: { reason: string; email: string } }>(
      `SELECT payload FROM app.events WHERE type = 'identity.oidc.refused' ORDER BY id DESC LIMIT 1`,
    );
    expect(ev?.payload).toMatchObject({ reason: 'domain_not_allowed', email: 'mallory@other.com' });
  });

  it('refuses a personal account (no hd), a foreign hd and an unverified address', async () => {
    expect((await signIn(googleId, 'google', { email: 'someone@kahf.co', email_verified: true })).location).toBe('/sign-in?error=domain_not_allowed');
    expect((await signIn(googleId, 'google', google('someone@kahf.co', { hd: 'other.com' }))).location).toBe('/sign-in?error=domain_not_allowed');
    expect((await signIn(googleId, 'google', google('someone@kahf.co', { email_verified: false }))).location).toBe('/sign-in?error=email_not_verified');
    expect(await one('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', ['someone@kahf.co'])).toBeUndefined();
  });
});

describe('Microsoft: tenant', () => {
  const ms = (email: string, tid: string): FakeLoginClaims => ({ email, tid, name: 'Nadia K', sub: `ms-${email}` });

  it('accepts the configured tenant', async () => {
    const run = await signIn(microsoftId, 'microsoft', ms('nadia.k@kahf.co', TENANT));
    expect(run.location).toBe('/');
    expect(await one('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', ['nadia.k@kahf.co'])).toBeDefined();
  });

  it('refuses another tenant even for an allowed domain', async () => {
    const run = await signIn(microsoftId, 'microsoft', ms('eve@kahf.co', OTHER_TENANT));
    expect(run.location).toBe('/sign-in?error=tenant_not_allowed');
    expect(await one('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', ['eve@kahf.co'])).toBeUndefined();
  });

  it('refuses a domain that is not on the list', async () => {
    expect((await signIn(microsoftId, 'microsoft', ms('eve@other.com', TENANT))).location).toBe('/sign-in?error=domain_not_allowed');
  });
});

describe('any OIDC provider', () => {
  it('failed discovery leaves the provider disabled with the reason, and it cannot be used', async () => {
    fake.failDiscovery('broken');
    const created = await post<OidcProviderResponse>('/api/auth/oidc/providers', {
      kind: 'oidc', issuer: fake.issuer('broken'), clientId: 'broken-client', clientSecret: 'x', label: 'Broken SSO',
    });
    expect(created.status).toBe(200);
    const p = OidcProviderResponse.parse(created.body).provider;
    expect(p.enabled).toBe(false);
    expect(p.disabledReason).toContain('Could not read the discovery document');
    expect(p.lastTest).toMatchObject({ ok: false });
    const methods = ListOidcMethodsResponse.parse(await (await createApiClient(s.url).get('/api/auth/oidc/methods')).json()).methods;
    expect(methods.map((m) => m.label)).not.toContain('Broken SSO');
    expect((await signIn(p.id, 'broken', google('a@kahf.co'))).location).toBe('/sign-in?error=provider_disabled');

    const stillBroken = OidcProviderResponse.parse((await post(`/api/auth/oidc/providers/${p.id}/enable`, undefined)).body).provider;
    expect(stillBroken).toMatchObject({ enabled: false });
    expect(stillBroken.disabledReason).toBeTruthy();

    fake.failDiscovery('broken', false);
    const fixed = OidcProviderResponse.parse((await post(`/api/auth/oidc/providers/${p.id}/enable`, undefined)).body).provider;
    expect(fixed).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('an issuer that does not answer at all is refused with a reason too', async () => {
    const dead = await post<OidcProviderResponse>('/api/auth/oidc/providers', {
      kind: 'oidc', issuer: 'http://127.0.0.1:9', clientId: 'c', clientSecret: 's',
    });
    const p = OidcProviderResponse.parse(dead.body).provider;
    expect(p.enabled).toBe(false);
    expect(p.disabledReason).toBeTruthy();
  });

  it('signs in with a verified email and links an existing person by that email', async () => {
    await sql('UPDATE app.workspaces SET self_signup = false WHERE id = $1', [OMAR.workspaceId]);
    // Nadia exists with a password and no verified address on file: refused until the address is verified.
    const refused = await signIn(anyId, 'any', { email: NADIA.email, email_verified: true, sub: 'any-nadia' });
    expect(refused.location).toBe('/sign-in?error=account_unverified');
    await sql('INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now())', [NADIA.workspaceId, NADIA.personId, NADIA.email]);
    const run = await signIn(anyId, 'any', { email: NADIA.email, email_verified: true, sub: 'any-nadia' });
    expect(run.location).toBe('/');
    const session = GetSessionResponse.parse(await (await fetch(`${s.url}/api/session`, { headers: { cookie: run.browser.cookieHeader() } })).json());
    expect(session).toMatchObject({ authenticated: true, person: { id: NADIA.personId } });
    expect((await sql('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', [NADIA.email])).length).toBe(1);
    const link = await one<{ person_id: string }>('SELECT person_id FROM app.identities WHERE subject = $1', ['any-nadia']);
    expect(link?.person_id).toBe(NADIA.personId);
  });

  it('refuses a second login at the same provider for an already linked person', async () => {
    const run = await signIn(anyId, 'any', { email: NADIA.email, email_verified: true, sub: 'any-nadia-other' });
    expect(run.location).toBe('/sign-in?error=identity_mismatch');
  });

  it('does not sign in a suspended person', async () => {
    await sql(`UPDATE app.people SET status = 'suspended' WHERE id = $1`, [NADIA.personId]);
    const run = await signIn(anyId, 'any', { email: NADIA.email, email_verified: true, sub: 'any-nadia' });
    expect(run.location).toBe('/sign-in?error=account_suspended');
    await sql(`UPDATE app.people SET status = 'active' WHERE id = $1`, [NADIA.personId]);
  });

  it('links a person without a password by the primary email alone', async () => {
    await sql('DELETE FROM app.password_credentials WHERE person_id = $1', [TARIQ.personId]);
    const run = await signIn(anyId, 'any', { email: TARIQ.email, email_verified: true, sub: 'any-tariq-seed' });
    expect(run.location).toBe('/');
    expect((await one<{ person_id: string }>('SELECT person_id FROM app.identities WHERE subject = $1', ['any-tariq-seed']))?.person_id).toBe(TARIQ.personId);
  });

  it('needs an invitation when sign-up is closed, and an open invitation creates the person with its role and team', async () => {
    const closed = await signIn(anyId, 'any', { email: 'new.hire@kahf.example', email_verified: true, sub: 'any-new' });
    expect(closed.location).toBe('/sign-in?error=signup_closed');
    expect(await one('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', ['new.hire@kahf.example'])).toBeUndefined();

    const inv = await one<{ id: string }>(
      `INSERT INTO app.invitations (workspace_id, team_id, email, role, grant_spec, token_hash) VALUES ($1, $2, $3, 'member', '{"teamRole":"member"}', $4) RETURNING id`,
      [OMAR.workspaceId, TEAM_IDS.Engineering, 'New.Hire@kahf.example', Buffer.from('oidc-test-invite-hash-0000000000')],
    );
    const run = await signIn(anyId, 'any', { email: 'new.hire@kahf.example', email_verified: true, sub: 'any-new', name: 'New Hire' });
    expect(run.location).toBe('/');
    const person = await one<{ id: string; display_name: string }>('SELECT id, display_name FROM app.people WHERE lower(primary_email) = $1', ['new.hire@kahf.example']);
    expect(person?.display_name).toBe('New Hire');
    expect((await one<{ role: string }>('SELECT role FROM app.workspace_members WHERE person_id = $1', [person?.id]))?.role).toBe('member');
    expect((await one<{ accepted_at: Date | null }>('SELECT accepted_at FROM app.invitations WHERE id = $1', [inv?.id]))?.accepted_at).not.toBeNull();
    expect(await one(`SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id WHERE a.ref_id = $1 AND tm.team_id = $2`, [person?.id, TEAM_IDS.Engineering])).toBeDefined();
    expect(await one(`SELECT 1 FROM app.events WHERE type = 'workspace.invitation.accepted'`)).toBeDefined();
  });
});

describe('state, nonce and token checks', () => {
  beforeAll(async () => {
    await sql('UPDATE app.workspaces SET self_signup = true WHERE id = $1', [OMAR.workspaceId]);
  });
  const login = (): FakeLoginClaims => google('checks@kahf.co', { sub: 'g-checks' });
  const noPerson = async (): Promise<void> => {
    expect(await one('SELECT 1 FROM app.people WHERE lower(primary_email) = $1', ['checks@kahf.co'])).toBeUndefined();
  };

  it('refuses a state that does not match the browser cookie', async () => {
    const run = await signIn(googleId, 'google', login(), { tweakCallback: (u) => u.searchParams.set('state', 'forged-state-value') });
    expect(run.location).toBe('/sign-in?error=state_invalid');
    await noPerson();
  });

  it('refuses a callback from a browser that did not start the flow', async () => {
    const run = await signIn(googleId, 'google', login(), { dropCookie: true });
    expect(run.location).toBe('/sign-in?error=state_invalid');
    await noPerson();
  });

  it('refuses a callback with a state nobody issued, even with a matching cookie', async () => {
    const browser = new Browser();
    browser.jar.set('manythreads_oidc', 'made-up');
    const res = await browser.nav(`${s.url}/api/auth/oidc/callback?code=abc&state=made-up`);
    expect(res.headers.get('location')).toBe('/sign-in?error=state_invalid');
  });

  it('refuses an id_token with the wrong nonce', async () => {
    const run = await signIn(googleId, 'google', login(), { fake: { nonce: 'attacker-nonce' } });
    expect(run.location).toBe('/sign-in?error=token_invalid');
    await noPerson();
  });

  it('refuses a bad signature, a wrong audience and an expired token', async () => {
    expect((await signIn(googleId, 'google', login(), { fake: { badSignature: true } })).location).toBe('/sign-in?error=token_invalid');
    expect((await signIn(googleId, 'google', login(), { fake: { audience: 'someone-else' } })).location).toBe('/sign-in?error=token_invalid');
    expect((await signIn(googleId, 'google', login(), { fake: { expired: true } })).location).toBe('/sign-in?error=token_invalid');
    expect((await signIn(googleId, 'google', login(), { fake: { omitIdToken: true } })).location).toBe('/sign-in?error=token_invalid');
    await noPerson();
  });

  it('answers an error from the provider and a missing code with access_denied', async () => {
    expect((await signIn(googleId, 'google', null)).location).toBe('/sign-in?error=access_denied');
    const run = await signIn(googleId, 'google', login(), { tweakCallback: (u) => u.searchParams.delete('code') });
    expect(run.location).toBe('/sign-in?error=access_denied');
  });

  it('a callback works once: replaying it is refused', async () => {
    const first = await signIn(googleId, 'google', google('replay@kahf.co', { sub: 'g-replay' }));
    expect(first.location).toBe('/');
    const replay = await first.browser.nav(first.callback);
    expect(replay.headers.get('location')).toBe('/sign-in?error=state_invalid');
  });

  it('only ever returns to a path on this site', async () => {
    const evil = await signIn(googleId, 'google', google('path@kahf.co', { sub: 'g-path' }), { returnTo: 'https://evil.example/x' });
    expect(evil.location).toBe('/');
    const proto = await signIn(googleId, 'google', google('path@kahf.co', { sub: 'g-path' }), { returnTo: '//evil.example' });
    expect(proto.location).toBe('/');
  });

  it('answers 302 to sign-in for an unknown or malformed provider id', async () => {
    const browser = new Browser();
    expect((await browser.nav(`${s.url}/api/auth/oidc/not-a-uuid/start`)).headers.get('location')).toBe('/sign-in?error=provider_disabled');
    expect((await browser.nav(`${s.url}/api/auth/oidc/00000000-0000-7000-8000-000000000000/start`)).headers.get('location')).toBe('/sign-in?error=provider_disabled');
  });

  it('keeps the flow state in an HttpOnly cookie and only a hash in the table', async () => {
    const browser = new Browser();
    const res = await fetch(`${s.url}/api/auth/oidc/${googleId}/start`, { redirect: 'manual' });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('manythreads_oidc='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/oidc/);
    const state = /manythreads_oidc=([^;]+)/.exec(cookie ?? '')?.[1] ?? '';
    const rows = await sql<{ state_hash: Buffer }>('SELECT state_hash FROM app.oidc_flows');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.state_hash.toString('utf8').includes(state))).toBe(true);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('hd')).toBeNull(); // two allowed domains: no single hint
    expect(browser.jar.size).toBe(0);
  });
});

describe('workspaces never mix', () => {
  let otherGoogleId = '';
  const OTHER_WORKSPACE = '00000000-0000-7000-8000-00000000a002';
  const OTHER_ADMIN = '00000000-0000-7000-8000-0000000c00f1';

  it('a person of one workspace is never linked through another workspace\'s provider', async () => {
    await sql(`INSERT INTO app.workspaces (id, slug, name) VALUES ($1, 'other-co', 'Other Co')`, [OTHER_WORKSPACE]);
    await sql(`INSERT INTO app.people (id, workspace_id, display_name, primary_email) VALUES ($1, $2, 'Other Admin', 'admin@other-co.example')`, [OTHER_ADMIN, OTHER_WORKSPACE]);
    await sql(`INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [OTHER_WORKSPACE, OTHER_ADMIN]);
    const otherAdmin = createApiClient(s.url);
    expect((await otherAdmin.testSignIn('admin@other-co.example', TEST_AUTH_TOKEN)).status).toBe(200);
    const created = await post<OidcProviderResponse>(
      '/api/auth/oidc/providers',
      { kind: 'google', clientId: 'google-client', clientSecret: SECRETS.google, allowedDomains: ['kahf.co'] },
      otherAdmin,
    );
    otherGoogleId = OidcProviderResponse.parse(created.body).provider.id;
    // The first workspace's admin does not see it, and cannot touch it.
    const mine = ListOidcProvidersResponse.parse((await get('/api/auth/oidc/providers')).body).providers;
    expect(mine.map((p) => p.id)).not.toContain(otherGoogleId);
    expect((await admin.request('PATCH', `/api/auth/oidc/providers/${otherGoogleId}`, { body: { label: 'hijack' } })).status).toBe(404);
    expect((await admin.post(`/api/auth/oidc/providers/${otherGoogleId}/disable`)).status).toBe(404);
  });

  it('tariq@kahf.co of the first workspace is not linked into the second: closed sign-up refuses him', async () => {
    const tariq = await one<{ id: string }>('SELECT id FROM app.people WHERE lower(primary_email) = $1 AND workspace_id = $2', ['tariq@kahf.co', OMAR.workspaceId]);
    expect(tariq).toBeDefined();
    const run = await signIn(otherGoogleId, 'google', google('tariq@kahf.co', { sub: 'g-tariq' }));
    expect(run.location).toBe('/sign-in?error=signup_closed');
    const links = await sql('SELECT 1 FROM app.identities WHERE person_id = $1 AND workspace_id <> $2', [tariq?.id, OMAR.workspaceId]);
    expect(links.length).toBe(0);
  });

  it('with open sign-up the second workspace gets its own, different person', async () => {
    await sql('UPDATE app.workspaces SET self_signup = true WHERE id = $1', [OTHER_WORKSPACE]);
    const run = await signIn(otherGoogleId, 'google', google('tariq@kahf.co', { sub: 'g-tariq' }));
    expect(run.location).toBe('/');
    const people = await sql<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM app.people WHERE lower(primary_email) = $1', ['tariq@kahf.co']);
    expect(people.length).toBe(2);
    expect(new Set(people.map((p) => p.workspace_id)).size).toBe(2);
    const ids = await sql<{ person_id: string; workspace_id: string; provider_id: string }>(`SELECT person_id, workspace_id, provider_id FROM app.identities WHERE subject = 'g-tariq'`);
    expect(ids.length).toBe(2);
    for (const i of ids) {
      expect(people.find((p) => p.id === i.person_id)?.workspace_id).toBe(i.workspace_id);
    }
    const session = GetSessionResponse.parse(await (await fetch(`${s.url}/api/session`, { headers: { cookie: run.browser.cookieHeader() } })).json());
    expect(session).toMatchObject({ authenticated: true, workspace: { id: OTHER_WORKSPACE } });
  });

  it('the database refuses an identity that points at a person of another workspace', async () => {
    const aPerson = await one<{ id: string }>('SELECT id FROM app.people WHERE workspace_id = $1 LIMIT 1', [OMAR.workspaceId]);
    await expect(
      sql(`INSERT INTO app.identities (workspace_id, person_id, provider_id, subject) VALUES ($1, $2, $3, 'cross')`, [OTHER_WORKSPACE, aPerson?.id, otherGoogleId]),
    ).rejects.toThrow(/workspace/);
  });
});

describe('secrets', () => {
  it('no response, header, event or provider row ever contained a client secret', async () => {
    expect(seen.length).toBeGreaterThan(30);
    for (const secret of Object.values(SECRETS)) {
      expect(seen.some((t) => t.includes(secret))).toBe(false);
    }
    const everything = JSON.stringify({
      providers: await sql('SELECT * FROM app.auth_providers'),
      events: await sql('SELECT payload FROM app.events'),
      flows: await sql('SELECT workspace_id, provider_id, return_to FROM app.oidc_flows'),
    });
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    expect(JSON.stringify(await (await fetch(`${s.url}/openapi.json`)).json())).not.toContain('client-secret');
  });

  it('the app role (any request) cannot read the secret table, even as the workspace owner', async () => {
    await expect(
      withActor({ kind: 'person', id: OMAR.actorId, workspaceId: OMAR.workspaceId }, (tx) => tx.query('SELECT * FROM app.secrets'), {
        pool: s.pools.app,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('deleting a provider deletes its secret', async () => {
    const created = OidcProviderResponse.parse(
      (await post('/api/auth/oidc/providers', { kind: 'oidc', issuer: fake.issuer('any'), clientId: 'any-client', clientSecret: 'temp-secret-123456' })).body,
    ).provider;
    const row = await one<{ secret_id: string }>('SELECT secret_id FROM app.auth_providers WHERE id = $1', [created.id]);
    expect(await one('SELECT 1 FROM app.secrets WHERE id = $1', [row?.secret_id])).toBeDefined();
    const del = await admin.delete(`/api/auth/oidc/providers/${created.id}`);
    expect(del.status).toBe(200);
    expect(await one('SELECT 1 FROM app.auth_providers WHERE id = $1', [created.id])).toBeUndefined();
    expect(await one('SELECT 1 FROM app.secrets WHERE id = $1', [row?.secret_id])).toBeUndefined();
  });
});
