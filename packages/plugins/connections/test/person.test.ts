import { randomUUID } from 'node:crypto';
import { createAppPool, createSecretService, createSystemPool, withSystem, CapabilityBroker, CapabilityRegistry, createDbGrantSource, createRunService, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { ListPersonConnectionsResponse, McpRunMintResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeProviders, type FakeProviders } from '@manythreads/test-utils';
import { describeToolSourceIntersection, type CallOutcome } from '@manythreads/test-utils/tool-source-intersection';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { compileBot, dropBot, readConnectionSecret } from '../src/index.ts';
import type { Declared } from '../src/compile.ts';
import { accessTokenFor, ConnectionProblem, type OAuthDeps } from '../src/oauth/store.ts';
import { PERSON_TOOL_DEFS } from '../src/person-tools.ts';

// P8-02: a person's own connection to Google, Microsoft 365 and Notion, on a real server and a fake provider (packages/test-utils/src/fake-providers.ts; no real
// network). The sign-in is the real OAuth code flow with PKCE against the fake; the tools are called through the real MCP gateway as a bot that a person asked.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, priya, sameera, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
const WS = omar.workspaceId;

let w: RepoWorld;
let fake: FakeProviders;
let sysPool: pg.Pool;
let deps: OAuthDeps;
const savedEnv: Record<string, string | undefined> = {};

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const asPlugin = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => sys((tx) => fn(tx as unknown as PluginTx));
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// ---- the browser's side of a sign-in ----

const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
/** One request as `who`; redirects are not followed, so the test sees the server's own 302. */
const raw = (who: Who, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function begin(who: Who, provider: PersonProviderId, body: Record<string, unknown> = {}): Promise<string> {
  const res = await raw(who, 'POST', `/api/me/connections/${provider}/start`, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return StartPersonConnectionResponse.parse(await res.json()).url;
}
/** The person says yes at the fake provider: its consent address answers with a redirect back to us, carrying the code and the state. */
async function consent(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}
/** The browser arrives back at the callback (the address is the server's, whatever public address the redirect names). */
async function arrive(who: Who, back: URL): Promise<URL> {
  const res = await raw(who, 'GET', `${back.pathname}${back.search}`);
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return new URL(res.headers.get('location')!, 'http://site.invalid');
}
/** A whole sign-in. The fake provider signs in as the person's own account. */
async function connect(who: Who & { email: string }, provider: PersonProviderId, services?: string[], returnTo?: string): Promise<URL> {
  fake.signInAs(who.email);
  const url = await begin(who, provider, { ...(services ? { services } : {}), ...(returnTo ? { returnTo } : {}) });
  return arrive(who, await consent(url));
}
const providersOf = async (who: Who) => {
  const res = await w.call(who, 'GET', '/api/me/connections/providers');
  expect(res.status).toBe(200);
  return ListPersonConnectionsResponse.parse(res.body).providers;
};
const providerOf = async (who: Who, id: PersonProviderId) => (await providersOf(who)).find((p) => p.id === id)!;

const connectionOf = (who: { actorId: string }, provider: PersonProviderId) =>
  sys(async (tx) =>
    (await tx.query<{ id: string; status: string; scope: string; state: string; scopes: string[]; has_credentials: boolean }>(
      `SELECT c.id, c.status, c.scope, o.state, o.scopes, c.has_credentials FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id WHERE c.owner_id = $1 AND c.slug = $2`,
      [who.actorId, provider],
    )).rows[0],
  );
const secretOf = (connectionId: string, name: 'access_token' | 'refresh_token') => readConnectionSecret(deps, { workspaceId: WS, connectionId, name });
const secretRows = () => sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);

beforeAll(async () => {
  fake = await startFakeProviders();
  for (const [k, v] of Object.entries(fake.env())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  // two people with different things in their accounts
  fake.account(nadia.email).files = [{ id: 'nadia-plan', name: 'Hiring plan', mimeType: 'text/plain', modified: '2026-10-29T10:00:00.000Z', text: 'Only Nadia keeps the hiring plan: two engineers in January.' }];
  w = await createRepoWorld();
  sysPool = createSystemPool(w.server.db.systemUrl, 2);
  deps = {
    db: { system: (fn, options) => withSystem((tx) => fn(tx as unknown as PluginTx), { pool: sysPool, ...(options?.workspaceId ? { workspaceId: options.workspaceId as never } : {}) }) },
    secrets: createSecretService(),
    now: () => new Date(),
    env: process.env,
  };
}, 180_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await sysPool?.end();
  await w?.close();
  await fake?.stop();
});

describe('connecting', () => {
  it('lists the providers with what each offers, and says whether the server is set up for it', async () => {
    const list = await providersOf(omar);
    expect(list.map((p) => p.id)).toEqual(['google', 'microsoft', 'notion', 'jira', 'linear', 'githubissues', 'asana', 'zendesk', 'intercom', 'hubspot', 'salesforce', 'confluence', 'dropbox', 'box']);
    const google = list[0]!;
    expect(google).toMatchObject({ configured: true, connected: false, state: null, accountLabel: null });
    expect(google.redirectUri).toMatch(/\/api\/me\/connections\/google\/callback$/);
    expect(google.services.map((s) => s.id)).toEqual(['drive', 'gmail', 'gmail_drafts', 'calendar', 'calendar_write', 'gmail_labels', 'gmail_send', 'calendar_free_busy']);
    expect(google.services.find((s) => s.id === 'drive')).toMatchObject({ tools: ['google_drive.search', 'google_drive.read'], writes: false, granted: false });
    expect(google.services.find((s) => s.id === 'calendar_write')).toMatchObject({ tools: ['google_calendar.create_event', 'google_calendar.update_event'], writes: true });
    expect(google.services.find((s) => s.id === 'gmail_send')).toMatchObject({ tools: ['gmail.send'], writes: true, granted: false });
    expect(google.services.find((s) => s.id === 'calendar_free_busy')).toMatchObject({ tools: ['google_calendar.free_busy', 'calendar.find_free_time'], writes: false });
    expect((await w.call(null, 'GET', '/api/me/connections/providers')).status).toBe(401);
  });

  it('answers a plain 409 when the server has no app for the provider, and says so in the list', async () => {
    const id = process.env['MANYTHREADS_OAUTH_NOTION_CLIENT_ID'];
    delete process.env['MANYTHREADS_OAUTH_NOTION_CLIENT_ID'];
    try {
      const res = await raw(omar, 'POST', '/api/me/connections/notion/start', {});
      expect(res.status).toBe(409);
      const text = JSON.stringify(await res.json());
      expect(text).toContain('Notion is not set up on this server yet');
      expect(text).toContain('client id and secret');
      expect((await providerOf(omar, 'notion')).configured).toBe(false);
    } finally {
      process.env['MANYTHREADS_OAUTH_NOTION_CLIENT_ID'] = id!;
    }
    expect((await providerOf(omar, 'notion')).configured).toBe(true);
  });

  it('refuses a provider, a service or a body it does not know', async () => {
    expect((await raw(nadia, 'POST', '/api/me/connections/evernote/start', {})).status).toBe(400);
    expect((await raw(nadia, 'POST', '/api/me/connections/google/start', { services: ['everything'] })).status).toBe(400);
    expect((await raw(nadia, 'POST', '/api/me/connections/google/start', { surprise: true })).status).toBe(400);
  });

  it('sends the browser to the provider with the PKCE proof and the offline grant, and keeps the state only as a hash', async () => {
    const before = fake.consents.length;
    const url = new URL(await begin(omar, 'google'));
    expect(url.origin).toBe(fake.url);
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(fake.clientId);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('include_granted_scopes')).toBe('true');
    expect(q.get('redirect_uri')).toMatch(/\/api\/me\/connections\/google\/callback$/);
    expect(q.get('scope')!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']);
    const state = q.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(43);
    const stored = await sys(async (tx) => (await tx.query<{ state_hash: Buffer; code_verifier: string; owner_id: string }>('SELECT state_hash, code_verifier, owner_id FROM app.connection_oauth_flows')).rows);
    const mine = stored.filter((r) => r.owner_id === omar.actorId);
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r.state_hash.toString('utf8')).not.toContain(state);
    expect(fake.consents.length).toBe(before);
    // the app can only be reached by the signed-in person that started it; the flow is gone once used (next test) and expires on its own
    await consent(url.toString());
  });

  it('a full sign-in: the code is traded with the PKCE proof, the person’s connection is made and the tokens are sealed', async () => {
    const finalUrl = await connect(omar, 'google');
    expect(finalUrl.pathname).toBe('/settings/connections');
    expect(finalUrl.searchParams.get('connected')).toBe('google');
    const call = fake.tokenCalls.filter((c) => c.provider === 'google' && c.grant === 'authorization_code').at(-1)!;
    expect(call).toMatchObject({ ok: true, pkce: true, clientAuth: 'body' });
    const consentSeen = fake.consents.at(-1)!;
    expect(consentSeen).toMatchObject({ provider: 'google', offline: true, hasChallenge: true });

    const p = await providerOf(omar, 'google');
    expect(p).toMatchObject({ connected: true, state: 'ok', accountLabel: omar.email });
    expect(p.services.filter((s) => s.granted).map((s) => s.id)).toEqual(['drive', 'calendar']);

    const row = (await connectionOf(omar, 'google'))!;
    expect(row).toMatchObject({ scope: 'person', status: 'enabled', state: 'ok', has_credentials: true });
    const access = await secretOf(row.id, 'access_token');
    const refresh = await secretOf(row.id, 'refresh_token');
    expect(access).toMatch(/^access-/);
    expect(refresh).toMatch(/^refresh-/);
    const sealed = await sys(async (tx) => (await tx.query<{ ciphertext: Buffer }>('SELECT s.ciphertext FROM app.connection_secrets cs JOIN app.secrets s ON s.id = cs.secret_id WHERE cs.connection_id = $1', [row.id])).rows);
    expect(sealed).toHaveLength(2);
    for (const s of sealed) {
      expect(s.ciphertext.toString('latin1')).not.toContain(access);
      expect(s.ciphertext.toString('latin1')).not.toContain(refresh);
    }
    // no route, log or event carries a token
    expect(JSON.stringify(await providersOf(omar))).not.toContain(access);
    expect(w.server.logs.join('\n')).not.toContain(access);
    expect(w.server.logs.join('\n')).not.toContain(refresh);
    const events = await sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.events WHERE payload::text LIKE '%' || $1 || '%'`, [access])).rows[0]!.n);
    expect(events).toBe(0);
  });

  it('the connection is the person’s alone: nobody else sees it, not even a lead', async () => {
    expect((await providerOf(nadia, 'google')).connected).toBe(false);
    expect((await providerOf(tariq, 'google')).connected).toBe(false);
    const seen = await w.as(nadia, async (tx) => (await tx.query('SELECT id FROM app.connections WHERE scope = $1', ['person'])).rows.length);
    expect(seen).toBe(0);
    const oauthSeen = await w.as(nadia, async (tx) => (await tx.query('SELECT connection_id FROM app.connection_oauth')).rows.length);
    expect(oauthSeen).toBe(0);
    const flows = await w.as(omar, async (tx) => tx.query('SELECT 1 FROM app.connection_oauth_flows').catch((e: Error) => e.message));
    expect(typeof flows === 'string' ? flows : 'readable').toMatch(/permission denied/);
  });

  it('a state works once: coming back with it again is “expired”', async () => {
    fake.signInAs(omar.email);
    const back = await consent(await begin(omar, 'google'));
    expect((await arrive(omar, back)).searchParams.get('connected')).toBe('google');
    expect((await arrive(omar, back)).searchParams.get('connect_error')).toBe('expired');
  });

  it('a state nobody started, or none at all, is “expired” and trades nothing', async () => {
    const before = fake.tokenCalls.length;
    const none = await raw(omar, 'GET', '/api/me/connections/google/callback?code=abc');
    expect(new URL(none.headers.get('location')!, 'http://x').searchParams.get('connect_error')).toBe('expired');
    const made = await raw(omar, 'GET', `/api/me/connections/google/callback?code=abc&state=${randomUUID()}`);
    expect(new URL(made.headers.get('location')!, 'http://x').searchParams.get('connect_error')).toBe('expired');
    expect(fake.tokenCalls.length).toBe(before);
  });

  it('the sign-in must finish as the person who started it; the code is not traded and the state is spent', async () => {
    fake.signInAs(nadia.email);
    const back = await consent(await begin(nadia, 'google'));
    const before = fake.tokenCalls.length;
    expect((await arrive(omar, back)).searchParams.get('connect_error')).toBe('wrong_person');
    expect(fake.tokenCalls.length).toBe(before);
    expect((await arrive(nadia, back)).searchParams.get('connect_error')).toBe('expired');
    expect((await providerOf(nadia, 'google')).connected).toBe(false);
  });

  it('a provider that comes back with an error is “denied”, and a refused trade is “failed” (the reason stays out of the address)', async () => {
    fake.signInAs(nadia.email);
    fake.denyNextConsent();
    const denied = await arrive(nadia, await consent(await begin(nadia, 'google')));
    expect(denied.searchParams.get('connect_error')).toBe('denied');
    expect(denied.searchParams.get('connected')).toBeNull();

    const back = await consent(await begin(nadia, 'google'));
    fake.failNextToken(503);
    const failed = await arrive(nadia, back);
    expect(failed.searchParams.get('connect_error')).toBe('failed');
    expect(failed.search).not.toContain('503');
    expect((await providerOf(nadia, 'google')).connected).toBe(false);
  });

  it('comes back only to a path of this site', async () => {
    const own = await connect(omar, 'google', undefined, '/teams/engineering?tab=bots');
    expect(own.pathname + own.search).toBe('/teams/engineering?tab=bots&connected=google');
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      const url = await connect(omar, 'google', undefined, bad);
      expect(url.pathname, bad).toBe('/settings/connections');
    }
  });

  it('a second sign-in adds a service and keeps the ones already agreed to, on the same connection', async () => {
    const before = (await connectionOf(omar, 'google'))!;
    await connect(omar, 'google', ['gmail', 'gmail_drafts']);
    const after = (await connectionOf(omar, 'google'))!;
    expect(after.id).toBe(before.id);
    const p = await providerOf(omar, 'google');
    expect(p.services.filter((s) => s.granted).map((s) => s.id)).toEqual(['drive', 'gmail', 'gmail_drafts', 'calendar']);
    const count = await sys(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.connections WHERE owner_id = $1 AND slug = 'google'`, [omar.actorId])).rows[0]!.n);
    expect(count).toBe(1);
  });

  it('Microsoft: PKCE, the offline grant and the person’s address', async () => {
    const finalUrl = await connect(omar, 'microsoft');
    expect(finalUrl.searchParams.get('connected')).toBe('microsoft');
    expect(fake.consents.at(-1)).toMatchObject({ provider: 'microsoft', offline: true, hasChallenge: true });
    expect(fake.consents.at(-1)!.scopes).toEqual(expect.arrayContaining(['offline_access', 'User.Read', 'Files.Read', 'Calendars.Read']));
    expect(fake.tokenCalls.filter((c) => c.provider === 'microsoft' && c.grant === 'authorization_code').at(-1)).toMatchObject({ ok: true, pkce: true });
    expect(await providerOf(omar, 'microsoft')).toMatchObject({ connected: true, state: 'ok', accountLabel: omar.email });
  });

  it('Notion: no PKCE and no scopes, the app proves itself with Basic credentials and a JSON body, no refresh token is kept', async () => {
    const finalUrl = await connect(omar, 'notion');
    expect(finalUrl.searchParams.get('connected')).toBe('notion');
    expect(fake.consents.at(-1)).toMatchObject({ provider: 'notion', hasChallenge: false, scopes: [] });
    expect(fake.tokenCalls.filter((c) => c.provider === 'notion').at(-1)).toMatchObject({ ok: true, pkce: null, clientAuth: 'basic' });
    const p = await providerOf(omar, 'notion');
    expect(p).toMatchObject({ connected: true, state: 'ok' });
    expect(p.accountLabel).toContain('workspace');
    const row = (await connectionOf(omar, 'notion'))!;
    expect(await secretOf(row.id, 'access_token')).toMatch(/^access-/);
    await expect(secretOf(row.id, 'refresh_token')).rejects.toThrow(/no credential called/);
  });

  it('the fake provider holds the plugin to the protocol: a wrong verifier, a replayed code and a wrong secret all fail', async () => {
    fake.signInAs(nadia.email);
    const back = await consent(await begin(nadia, 'google'));
    const code = back.searchParams.get('code')!;
    const trade = (fields: Record<string, string>) =>
      fetch(`${fake.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: fake.clientId, client_secret: fake.clientSecret, grant_type: 'authorization_code', redirect_uri: `${back.origin}${back.pathname}`, ...fields }) });
    expect((await trade({ code, code_verifier: 'x'.repeat(50) })).status).toBe(400);
    expect((await trade({ code, code_verifier: 'x'.repeat(50) })).status).toBe(400);
    expect((await trade({ code, client_secret: 'wrong' })).status).toBe(401);
    // every real trade the plugin made held the proof
    for (const c of fake.tokenCalls.filter((c) => c.grant === 'authorization_code' && c.ok && c.provider !== 'notion')) expect(c.pkce).toBe(true);
  });

  it('disconnecting tells the provider, deletes the connection and every sealed token, and says false the second time', async () => {
    const row = (await connectionOf(omar, 'notion'))!;
    const before = await secretRows();
    const revoked = fake.revoked.length;
    const res = await w.call(omar, 'DELETE', '/api/me/connections/notion');
    expect(res).toMatchObject({ status: 200, body: { disconnected: true } });
    expect(fake.revoked.length).toBe(revoked + 1);
    expect(await connectionOf(omar, 'notion')).toBeUndefined();
    expect(await secretRows()).toBe(before - 1);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_secrets WHERE connection_id = $1', [row.id])).rows.length)).toBe(0);
    expect((await w.call(omar, 'DELETE', '/api/me/connections/notion')).body).toEqual({ disconnected: false });
    expect((await providerOf(omar, 'notion')).connected).toBe(false);
  });

  it('a bot cannot start, finish or end a person’s connection', async () => {
    const bot = await w.makeBot(ENG);
    for (const [method, path] of [
      ['GET', '/api/me/connections/providers'],
      ['POST', '/api/me/connections/google/start'],
      ['GET', '/api/me/connections/google/callback?code=a&state=b'],
      ['DELETE', '/api/me/connections/google'],
    ] as const) {
      const res = await raw(bot, method, path, method === 'POST' ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('keeping the sign-in alive', () => {
  let id: string;
  const microsoft = (): { id: string; workspaceId: string; provider: 'microsoft' } => ({ id, workspaceId: WS, provider: 'microsoft' });
  const refreshCalls = () => fake.tokenCalls.filter((c) => c.provider === 'microsoft' && c.grant === 'refresh_token');

  beforeAll(async () => {
    fake.setRotation('microsoft', true);
    await connect(rafi, 'microsoft');
    id = (await connectionOf(rafi, 'microsoft'))!.id;
  });

  it('a token that is still good is used as it is', async () => {
    const before = refreshCalls().length;
    const token = await accessTokenFor(deps, microsoft());
    expect(token).toBe(await secretOf(id, 'access_token'));
    expect(refreshCalls().length).toBe(before);
  });

  it('a refresh stores the new access token, and the new refresh token when the provider rotates it', async () => {
    const oldAccess = await secretOf(id, 'access_token');
    const oldRefresh = await secretOf(id, 'refresh_token');
    const token = await accessTokenFor(deps, microsoft(), { force: true });
    expect(token).not.toBe(oldAccess);
    expect(await secretOf(id, 'access_token')).toBe(token);
    expect(await secretOf(id, 'refresh_token')).not.toBe(oldRefresh);
    expect(refreshCalls().at(-1)).toMatchObject({ ok: true });
    // the next refresh uses the new one (the old one is dead at the provider)
    await expect(accessTokenFor(deps, microsoft(), { force: true })).resolves.toMatch(/^access-/);
  });

  it('a token about to expire is renewed once, however many calls ask at the same moment', async () => {
    await sys((tx) => tx.query(`UPDATE app.connection_oauth SET access_expires_at = now() - interval '1 minute' WHERE connection_id = $1`, [id]));
    const before = refreshCalls().length;
    const tokens = await Promise.all(Array.from({ length: 5 }, () => accessTokenFor(deps, microsoft())));
    expect(new Set(tokens).size).toBe(1);
    expect(refreshCalls().length).toBe(before + 1);
  });

  it('a provider that is down leaves the connection as it was and says so', async () => {
    fake.failNextToken(503);
    await expect(accessTokenFor(deps, microsoft(), { force: true })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await connectionOf(rafi, 'microsoft')).toMatchObject({ state: 'ok', status: 'enabled' });
    await expect(accessTokenFor(deps, microsoft(), { force: true })).resolves.toMatch(/^access-/);
  });

  it('a provider that no longer honours the sign-in switches the connection off and asks the person to connect again; connecting again fixes it', async () => {
    fake.revokeRefreshTokens();
    const failure = await accessTokenFor(deps, microsoft(), { force: true }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConnectionProblem);
    expect(failure).toMatchObject({ code: 'needs_reconnect' });
    expect(await connectionOf(rafi, 'microsoft')).toMatchObject({ state: 'needs_reconnect', status: 'disabled' });
    expect(await providerOf(rafi, 'microsoft')).toMatchObject({ connected: true, state: 'needs_reconnect' });
    // and it stays that way without calling the provider again
    const before = refreshCalls().length;
    await expect(accessTokenFor(deps, microsoft())).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect(refreshCalls().length).toBe(before);

    await connect(rafi, 'microsoft');
    expect(await connectionOf(rafi, 'microsoft')).toMatchObject({ state: 'ok', status: 'enabled' });
    await expect(accessTokenFor(deps, microsoft(), { force: true })).resolves.toMatch(/^access-/);
  });

  it('a short-lived token (under a minute) is renewed before every use', async () => {
    fake.setAccessTtl(30);
    try {
      await connect(rafi, 'microsoft');
      const before = refreshCalls().length;
      await accessTokenFor(deps, microsoft());
      await accessTokenFor(deps, microsoft());
      expect(refreshCalls().length).toBe(before + 2);
    } finally {
      fake.setAccessTtl(3600);
      await connect(rafi, 'microsoft');
    }
  });
});

// ---- the tools, through the gateway ----

const declared: Declared = new Map([['email.read', { destructive: false }], ...PERSON_TOOL_DEFS.map((t) => [t.name, { destructive: false }] as const)]);
const GOOGLE_TOOLS = PERSON_TOOL_DEFS.filter((t) => t.provider === 'google').map((t) => t.name);

async function makeBot(team: string, slug: string, connections: unknown = []): Promise<{ botId: string; actorId: string }> {
  return sys(async (tx) => {
    const botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, connections)
         VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('e', 64), 'active', $4::jsonb) RETURNING id`,
        [WS, team, slug, JSON.stringify(connections)],
      )
    ).rows[0]!.id;
    const actorId = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [WS, botId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [team, actorId, WS]);
    return { botId, actorId };
  });
}
const compile = (team: string, botId: string) => asPlugin((tx) => compileBot(tx, declared, { workspaceId: WS, teamId: team, botId }));
const setBotConnections = (botId: string, connections: unknown) => sys((tx) => tx.query(`UPDATE app.bots SET connections = $2::jsonb WHERE id = $1`, [botId, JSON.stringify(connections)]));

async function openRun(botId: string, team: string, askerActorId: string | null): Promise<McpRunMintResponse> {
  const appPool = createAppPool(w.server.db.appUrl);
  const pool = createSystemPool(w.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool }) });
    const service = createRunService({ pool: appPool, systemPool: pool, registry, broker, handlers: new Map() });
    const { run, token } = await service.open({ botId, teamId: team, workspaceId: WS, trigger: askerActorId === null ? 'webhook' : 'conversation', ...(askerActorId === null ? {} : { askerActorId }) });
    return McpRunMintResponse.parse({ runId: run.runId, botId: run.botId, url: `${w.server.url}/api/mcp/runs/${run.runId}`, token, expiresAt: run.expiresAt });
  } finally {
    await appPool.end();
    await pool.end();
  }
}
async function rpc(run: McpRunMintResponse, method: string, params?: unknown): Promise<{ result?: { tools?: Array<{ name: string; description: string }>; content?: Array<{ text: string }>; isError?: boolean } }> {
  const res = await fetch(`${w.server.url}/api/mcp/runs/${run.runId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await res.json()) as never;
}
const listed = async (run: McpRunMintResponse): Promise<string[]> => ((await rpc(run, 'tools/list')).result?.tools ?? []).map((t) => t.name);
const answers: string[] = [];
const called = async (run: McpRunMintResponse, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const body = await rpc(run, 'tools/call', { name, arguments: args });
  const text = body.result!.content![0]!.text;
  answers.push(text);
  return JSON.parse(text) as Record<string, unknown>;
};

describe('the compile of person:* tools', () => {
  it('writes the grant of the person’s own connection, always with approval for a tool that writes, and takes it away again', async () => {
    const bot = await makeBot(ENG, 'person-compile', [{ connection: 'person:*', tools: ['google_drive.search', 'google_calendar.create_event', 'email.read', 'ghost.tool'], needsApproval: [] }]);
    const result = await compile(ENG, bot.botId);
    expect(result.granted.length).toBe(2);
    expect(result.skipped.map((s) => `${s.connection}:${s.reason}`).sort()).toEqual(['person:*:tool_not_declared', 'person:*:tool_not_personal']);
    const grants = await sys(async (tx) => (await tx.query<{ tool: string; needs_approval: boolean }>('SELECT tool, needs_approval FROM app.person_connection_grants WHERE actor_id = $1 ORDER BY tool', [bot.actorId])).rows);
    expect(grants).toEqual([
      { tool: 'google_calendar.create_event', needs_approval: true },
      { tool: 'google_drive.search', needs_approval: false },
    ]);
    const broker = await sys(async (tx) => (await tx.query<{ capability: string; needs_approval: boolean; constraints: unknown }>(`SELECT capability, needs_approval, constraints FROM app.capability_grants WHERE actor_id = $1 AND constraints ? 'connection' ORDER BY capability`, [bot.actorId])).rows);
    expect(broker).toEqual([
      { capability: 'google_calendar.create_event', needs_approval: true, constraints: { connection: 'person:*' } },
      { capability: 'google_drive.search', needs_approval: false, constraints: { connection: 'person:*' } },
    ]);

    // the team sees the grants, someone outside it does not
    expect(await w.as(nadia, async (tx) => (await tx.query('SELECT 1 FROM app.person_connection_grants WHERE actor_id = $1', [bot.actorId])).rows.length)).toBe(2);
    expect(await w.as(sameera, async (tx) => (await tx.query('SELECT 1 FROM app.person_connection_grants WHERE actor_id = $1', [bot.actorId])).rows.length)).toBe(0);

    // a tool dropped from the definition loses its rows, and a removed bot loses them all
    await setBotConnections(bot.botId, [{ connection: 'person:*', tools: ['google_drive.search'] }]);
    await compile(ENG, bot.botId);
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.person_connection_grants WHERE actor_id = $1', [bot.actorId])).rows)).length).toBe(1);
    await asPlugin((tx) => dropBot(tx, { workspaceId: WS, botId: bot.botId }));
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.person_connection_grants WHERE actor_id = $1', [bot.actorId])).rows)).length).toBe(0);
    expect((await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.capability_grants WHERE actor_id = $1 AND constraints ? 'connection'`, [bot.actorId])).rows)).length).toBe(0);
  });
});

describe('the tools of a person’s connection, as a bot that the person asked', () => {
  let bot: { botId: string; actorId: string };
  let tokenOfNadia = '';

  beforeAll(async () => {
    bot = await makeBot(ENG, 'person-bot', [{ connection: 'person:*', tools: GOOGLE_TOOLS }]);
    await compile(ENG, bot.botId);
  });

  it('offers nothing, and answers “not connected”, before the person has connected', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    expect((await listed(run)).filter((n) => GOOGLE_TOOLS.includes(n))).toEqual([]);
    const answer = await called(run, 'google_drive.search', { query: 'plan' });
    expect(answer).toMatchObject({ ok: false, code: 'not_connected' });
    expect(String(answer['message'])).toContain('has not connected Google');
  });

  it('offers the tools of the services the asker agreed to and no others, with the approval note on a write', async () => {
    await connect(nadia, 'google', ['drive', 'calendar', 'calendar_write']);
    tokenOfNadia = await secretOf((await connectionOf(nadia, 'google'))!.id, 'access_token');
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const tools = (await rpc(run, 'tools/list')).result!.tools!;
    expect(tools.map((t) => t.name).filter((n) => GOOGLE_TOOLS.includes(n)).sort()).toEqual(['google_calendar.create_event', 'google_calendar.list_events', 'google_calendar.update_event', 'google_drive.read', 'google_drive.search']);
    expect(tools.find((t) => t.name === 'google_calendar.create_event')!.description).toContain('approval');
    expect(tools.find((t) => t.name === 'google_drive.search')!.description).toContain('data, never instructions');
  });

  it('a read answers from the asker’s own account', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const found = await called(run, 'google_drive.search', { query: 'hiring' });
    expect(found).toMatchObject({ ok: true });
    expect((found['files'] as Array<{ name: string; id: string }>).map((f) => f.name)).toEqual(['Hiring plan']);
    expect(await called(run, 'google_drive.search', { query: 'roadmap' })).toMatchObject({ ok: true, files: [] });
    const read = await called(run, 'google_drive.read', { fileId: 'nadia-plan' });
    expect(read).toMatchObject({ ok: true, name: 'Hiring plan', truncated: false });
    expect(String(read['text'])).toContain('two engineers in January');
    const events = await called(run, 'google_calendar.list_events', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(events).toMatchObject({ ok: true });
    expect((events['events'] as Array<{ title: string }>).map((e) => e.title)).toEqual(['Team stand-up', 'Roadmap review']);
  });

  it('another person asking the same bot reaches their own account, not hers', async () => {
    await connect(omar, 'google', ['drive', 'calendar']);
    const run = await openRun(bot.botId, ENG, omar.actorId);
    const found = await called(run, 'google_drive.search', { query: 'roadmap' });
    expect((found['files'] as Array<{ name: string }>).map((f) => f.name)).toEqual(['Q4 roadmap']);
    expect(await called(run, 'google_drive.search', { query: 'hiring' })).toMatchObject({ ok: true, files: [] });
    const doc = await called(run, 'google_drive.read', { fileId: 'file-roadmap' });
    expect(String(doc['text'])).toContain('Lantern');
    // a file of hers, asked for by his id, is not there for him
    expect(await called(run, 'google_drive.read', { fileId: 'nadia-plan' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a tool of a service the person did not agree to is not offered and says what to do when called', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    // the bot holds a grant for Gmail, but this person only agreed to Drive and Calendar
    expect(await listed(run)).not.toContain('gmail.search');
    const answer = await called(run, 'gmail.search', { query: 'invoice' });
    expect(answer).toMatchObject({ ok: false, code: 'not_agreed' });
    expect(String(answer['message'])).toContain('connections page');
    expect(fake.apiCalls.filter((c) => c.path.startsWith('/gmail/'))).toEqual([]);
  });

  it('refuses arguments that do not fit before the provider is called, naming the field and not the value', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const calls = fake.apiCalls.length;
    for (const args of [{ fileId: '../../secret' }, { fileId: 'a'.repeat(300) }, { fileId: 'x', extra: 'SENTINEL-value' }, {}]) {
      const answer = await called(run, 'google_drive.read', args);
      expect(answer, JSON.stringify(args)).toMatchObject({ ok: false, code: 'validation_failed' });
      expect(JSON.stringify(answer)).not.toContain('SENTINEL-value');
    }
    expect(await called(run, 'google_drive.search', { query: '' })).toMatchObject({ code: 'validation_failed' });
    expect(fake.apiCalls.length).toBe(calls);
  });

  it('words in a search are quoted for the provider and cannot change its query', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const answer = await called(run, 'google_drive.search', { query: `x' or name contains '` });
    expect(answer).toMatchObject({ ok: true, files: [] });
  });

  it('a run that nobody asked reaches no person’s connection', async () => {
    const run = await openRun(bot.botId, ENG, null);
    expect((await listed(run)).filter((n) => GOOGLE_TOOLS.includes(n))).toEqual([]);
    expect(await called(run, 'google_drive.search', { query: 'plan' })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('a write waits for the asker’s approval, and once approved runs once, as the bot, on the asker’s calendar', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const created = fake.createdEvents.length;
    const answer = await called(run, 'google_calendar.create_event', { title: 'Hiring sync', start: '2026-11-05T10:00:00+00:00', end: '2026-11-05T10:30:00+00:00', attendees: ['tariq@kahf.example'] });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.createdEvents.length).toBe(created);
    const pending = await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.approvals WHERE id = $1`, [answer['approvalId']])).rows[0]!.id);
    const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${pending}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => fake.createdEvents.length === created + 1, 30_000, 'the approved event to be added');
    expect(fake.createdEvents.at(-1)).toMatchObject({ provider: 'google', account: nadia.email, title: 'Hiring sync', start: '2026-11-05T10:00:00+00:00', guests: ['tariq@kahf.example'] });
    const row = await until(async () => (await sys(async (tx) => (await tx.query<{ outcome: string }>('SELECT outcome FROM app.approvals WHERE id = $1', [pending])).rows[0]!)).outcome === 'ran' || null, 30_000, 'the approval to be marked as run');
    expect(row).toBe(true);
  });

  it('a draft that no one has approved is never saved', async () => {
    expect(fake.drafts).toEqual([]);
  });

  it('a sign-in that the provider took back is found on the first call: the person is told to connect again, and the tools disappear', async () => {
    fake.expireAccessTokens();
    fake.revokeRefreshTokens();
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const answer = await called(run, 'google_drive.search', { query: 'hiring' });
    expect(answer).toMatchObject({ ok: false, code: 'needs_reconnect' });
    expect((await listed(await openRun(bot.botId, ENG, nadia.actorId))).filter((n) => GOOGLE_TOOLS.includes(n))).toEqual([]);
    expect(await providerOf(nadia, 'google')).toMatchObject({ connected: true, state: 'needs_reconnect' });
  });

  it('no answer, log or event of any of this carries a token', async () => {
    const all = answers.join('\n');
    expect(all).not.toContain(tokenOfNadia);
    expect(all).not.toMatch(/access-[A-Za-z0-9_-]{20}/);
    expect(all).not.toMatch(/refresh-[A-Za-z0-9_-]{20}/);
    expect(w.server.logs.join('\n')).not.toMatch(/(access|refresh)-[A-Za-z0-9_-]{20}/);
    expect(JSON.stringify(fake.apiCalls)).not.toMatch(/(access|refresh)-[A-Za-z0-9_-]{20}/);
  });
});

describe('Microsoft and Notion tools', () => {
  let bot: { botId: string; actorId: string };

  beforeAll(async () => {
    await connect(priya, 'microsoft', ['onedrive', 'mail', 'mail_drafts', 'calendar']);
    await connect(priya, 'notion');
    const tools = PERSON_TOOL_DEFS.filter((t) => t.provider !== 'google').map((t) => t.name);
    bot = await makeBot(ENG, 'person-other', [{ connection: 'person:*', tools }]);
    await compile(ENG, bot.botId);
  });

  it('search, read and calendar across OneDrive, Outlook and Notion', async () => {
    const run = await openRun(bot.botId, ENG, priya.actorId);
    const names = await listed(run);
    expect(names).toEqual(expect.arrayContaining(['onedrive.search', 'onedrive.read', 'outlook.search', 'outlook.read', 'outlook.draft', 'outlook_calendar.list_events', 'notion.search', 'notion.read_page', 'notion.create_page']));
    expect(names).not.toContain('outlook_calendar.create_event');

    const files = await called(run, 'onedrive.search', { query: 'customer call' });
    expect((files['files'] as Array<{ id: string }>).map((f) => f.id)).toEqual(['file-notes']);
    expect(String((await called(run, 'onedrive.read', { itemId: 'file-notes' }))['text'])).toContain('Harbour Grain');
    expect(await called(run, 'onedrive.read', { itemId: 'file-photo' })).toMatchObject({ ok: false, code: 'not_readable' });

    const mails = await called(run, 'outlook.search', { query: 'invoice' });
    expect((mails['messages'] as Array<{ subject: string }>).map((m) => m.subject)).toEqual(['Invoice 2041 is overdue']);
    expect(String((await called(run, 'outlook.read', { messageId: 'mail-invoice' }))['text'])).toContain('1,980 dollars');

    const events = await called(run, 'outlook_calendar.list_events', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect((events['events'] as unknown[]).length).toBe(2);

    const pages = await called(run, 'notion.search', { query: 'handbook' });
    expect((pages['pages'] as Array<{ id: string; title: string }>).map((p) => p.title)).toEqual(['Team handbook']);
    const page = await called(run, 'notion.read_page', { pageId: 'page-handbook' });
    expect(String(page['text'])).toContain('# Team handbook');
    expect(String(page['text'])).toContain('- Page the on-call engineer first');
  });

  it('a draft and a new page wait for approval, and nothing is made until it is given', async () => {
    const run = await openRun(bot.botId, ENG, priya.actorId);
    expect(await called(run, 'outlook.draft', { to: ['nadia@kahf.example'], subject: 'Offsite', body: 'Yes, count me in.' })).toMatchObject({ code: 'approval_pending' });
    expect(await called(run, 'notion.create_page', { parentPageId: 'page-handbook', title: 'Offsite notes', text: 'One.\n\nTwo.' })).toMatchObject({ code: 'approval_pending' });
    expect(fake.drafts).toEqual([]);
    expect(fake.createdPages).toEqual([]);
  });
});

// P16-03: Gmail labels and send, free/busy and changing an event, called through the real MCP gateway as a bot that a person asked, against the fake Google.
describe('Google Workspace in depth', () => {
  let bot: { botId: string; actorId: string };
  const WIDE = ['gmail_labels', 'gmail_send', 'gmail_drafts', 'calendar_free_busy', 'calendar_write'];
  const NEW_TOOLS = ['gmail.list_labels', 'gmail.label', 'gmail.send', 'google_calendar.free_busy', 'google_calendar.update_event'];
  const askerMail = () => fake.account(nadia.email).mails;

  const pendingOf = (answer: Record<string, unknown>) =>
    sys(async (tx) => (await tx.query<{ id: string; summary: string; args_preview: Record<string, unknown>; status: string }>('SELECT id, summary, args_preview, status FROM app.approvals WHERE id = $1', [answer['approvalId']])).rows[0]!);
  async function approve(id: string): Promise<void> {
    const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${id}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => (await sys(async (tx) => (await tx.query<{ outcome: string | null }>('SELECT outcome FROM app.approvals WHERE id = $1', [id])).rows[0]!.outcome)) === 'ran' || null, 30_000, 'the approval to be marked as run');
  }

  beforeAll(async () => {
    bot = await makeBot(ENG, 'google-depth', [{ connection: 'person:*', tools: GOOGLE_TOOLS }]);
    await compile(ENG, bot.botId);
    await connect(nadia, 'google', ['drive', 'gmail', 'calendar']);
  });

  it('offers the new tools only for the services the person agreed to, and says what to do when one is called without it', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const before = await listed(run);
    for (const name of ['gmail.label', 'gmail.send', 'google_calendar.free_busy']) expect(before, name).not.toContain(name);
    expect(before).toContain('google_calendar.update_event'); // she had agreed to Calendar (add and change events) in an earlier sign-in, which is kept
    expect(before).toContain('gmail.list_labels'); // a read of the Gmail (read) service
    const answer = await called(run, 'google_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-11-03T12:00:00Z' });
    expect(answer).toMatchObject({ ok: false, code: 'not_agreed' });
    expect(String(answer['message'])).toContain('Google Calendar (free and busy)');
    expect(fake.sentMails).toEqual([]);

    await connect(nadia, 'google', WIDE);
    const after = await listed(await openRun(bot.botId, ENG, nadia.actorId));
    for (const name of NEW_TOOLS) expect(after, name).toContain(name);
  });

  it('the consent page asks for the new scopes only when the person ticks them (incremental)', () => {
    const last = fake.consents.filter((c) => c.provider === 'google').at(-1)!;
    expect(last.scopes).toEqual(
      expect.arrayContaining(['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.freebusy']),
    );
    expect(fake.consents.filter((c) => c.provider === 'google').at(-2)!.scopes.join(' ')).not.toContain('gmail.send');
  });

  it('search and read show the labels and the subject of each message; the labels of the mailbox list with their ids', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const found = await called(run, 'gmail.search', { query: 'invoice' });
    expect(found['messages']).toEqual([expect.objectContaining({ id: 'mail-invoice', subject: 'Invoice 2041 is overdue', labels: ['INBOX', 'UNREAD', 'Label_invoices'], threadId: 'mail-invoice' })]);
    expect(await called(run, 'gmail.read', { messageId: 'mail-invoice' })).toMatchObject({ ok: true, labels: ['INBOX', 'UNREAD', 'Label_invoices'] });
    const labels = (await called(run, 'gmail.list_labels'))['labels'] as Array<{ id: string; name: string; type: string }>;
    expect(labels).toEqual(expect.arrayContaining([{ id: 'Label_invoices', name: 'Invoices', type: 'own' }, { id: 'INBOX', name: 'INBOX', type: 'built-in' }]));
  });

  it('a label change waits for approval with a card that names the message and the labels, then runs once', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const answer = await called(run, 'gmail.label', { messageId: 'mail-offsite', add: ['offsite'], remove: ['INBOX'] });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.labelChanges).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toBe('Label a message: add offsite, remove INBOX');
    expect(card.args_preview).toMatchObject({ messageId: 'mail-offsite', add: ['offsite'], remove: ['INBOX'] });
    await approve(card.id);
    expect(fake.labelChanges).toEqual([{ account: nadia.email, messageId: 'mail-offsite', add: ['Label_offsite'], remove: ['INBOX'] }]);
    expect(askerMail().find((m) => m.id === 'mail-offsite')!.labels).toEqual(['Label_offsite']);
  });

  it('a message goes out only after the person approves it, to the addresses on the card, in the conversation it answers', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const answer = await called(run, 'gmail.send', { to: ['billing@harbourgrain.example'], cc: ['nadia@kahf.example'], subject: 'Re: Invoice 2041 is overdue', body: 'We will pay on Friday.', replyToMessageId: 'mail-invoice' });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.sentMails).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toBe('Send an email to billing@harbourgrain.example: Re: Invoice 2041 is overdue');
    expect(card.args_preview).toMatchObject({ to: ['billing@harbourgrain.example'], cc: ['nadia@kahf.example'], subject: 'Re: Invoice 2041 is overdue', body: 'We will pay on Friday.', inReplyTo: 'mail-invoice' });
    await approve(card.id);
    expect(fake.sentMails).toEqual([
      { account: nadia.email, to: ['billing@harbourgrain.example'], cc: ['nadia@kahf.example'], subject: 'Re: Invoice 2041 is overdue', body: 'We will pay on Friday.', threadId: 'mail-invoice', inReplyTo: '<mail-invoice@mail.example>' },
    ]);
  });

  it('refuses a send with an address that could add a header, before anything is asked of Google', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const calls = fake.apiCalls.length;
    const sent = fake.sentMails.length;
    // the gateway holds any write for the person before it looks at the arguments; the card is not built for an invalid call and the run refuses it, so nothing is sent
    for (const args of [
      { to: ['a@b.co\r\nBcc: spy@evil.example'], subject: 's', body: 'b' },
      { to: ['a@b.co'], subject: 'x\r\nBcc: spy@evil.example', body: 'b' },
      { to: ['a@b.co'], bcc: ['spy@evil.example'], subject: 's', body: 'b' },
    ]) {
      const answer = await called(run, 'gmail.send', args);
      expect(['validation_failed', 'approval_pending']).toContain(answer['code']);
    }
    expect(fake.apiCalls.length).toBe(calls);
    expect(fake.sentMails.length).toBe(sent);
  });

  it('free and busy: the person’s own busy spans, another calendar as busy spans only, one that is not visible said so, and the free stretches of everyone', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const window = { from: '2026-11-03T08:00:00+00:00', to: '2026-11-03T12:00:00+00:00' };
    const answer = await called(run, 'google_calendar.free_busy', { ...window, people: [omar.email, 'stranger@elsewhere.example'], minMinutes: 30 });
    expect(answer['calendars']).toEqual([
      { who: 'you', visible: true, busy: [{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T09:15:00.000Z' }] },
      { who: omar.email, visible: true, busy: [{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T09:15:00.000Z' }] },
      { who: 'stranger@elsewhere.example', visible: false, busy: [] },
    ]);
    expect(answer['free']).toEqual([
      { start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T09:00:00.000Z' },
      { start: '2026-11-03T09:15:00.000Z', end: '2026-11-03T12:00:00.000Z' },
    ]);
    expect(answer['freeCoversEveryone']).toBe(false);
    // the event details are never part of the answer
    expect(JSON.stringify(answer)).not.toContain('stand-up');
    expect(await called(run, 'google_calendar.free_busy', { from: '2026-11-03T00:00:00Z', to: '2027-03-03T00:00:00Z' })).toMatchObject({ code: 'validation_failed' });
  });

  it('changing an event waits for approval, then changes only what was named', async () => {
    const run = await openRun(bot.botId, ENG, nadia.actorId);
    const answer = await called(run, 'google_calendar.update_event', { eventId: 'event-standup', title: 'Team stand-up (moved)', start: '2026-11-03T09:30:00+00:00', end: '2026-11-03T09:45:00+00:00' });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.updatedEvents).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toBe('Change event event-standup: title, start, end');
    await approve(card.id);
    expect(fake.updatedEvents).toHaveLength(1);
    expect(fake.updatedEvents[0]).toMatchObject({ account: nadia.email, eventId: 'event-standup', fields: { summary: 'Team stand-up (moved)', start: { dateTime: '2026-11-03T09:30:00+00:00' } } });
    expect(fake.updatedEvents[0]!.fields).not.toHaveProperty('attendees');
    expect(fake.updatedEvents[0]!.fields).not.toHaveProperty('description');
  });

  it('a token appears in no answer and no card', async () => {
    const cards = await sys(async (tx) => JSON.stringify((await tx.query('SELECT summary, args_preview FROM app.approvals')).rows));
    expect(`${answers.join('\n')}\n${cards}`).not.toMatch(/(access|refresh)-[A-Za-z0-9_-]{20}/);
  });
});

// P16-04: Outlook mail, the Outlook calendar, OneDrive and SharePoint, called through the real MCP gateway as a bot that a person asked, against the fake Microsoft.
describe('Microsoft 365 in depth', () => {
  let bot: { botId: string; actorId: string };
  const MICROSOFT_TOOLS_ALL = PERSON_TOOL_DEFS.filter((t) => t.provider === 'microsoft').map((t) => t.name);
  const WIDE = ['mail', 'mail_drafts', 'mail_categories', 'mail_send', 'calendar', 'calendar_write', 'calendar_free_busy', 'onedrive', 'sharepoint'];
  const NEW_TOOLS = ['outlook.list_folders', 'outlook.list_categories', 'outlook.categorize', 'outlook.send', 'outlook_calendar.free_busy', 'outlook_calendar.update_event', 'sharepoint.search', 'sharepoint.read'];
  const asker = priya;
  const SHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const pendingOf = (answer: Record<string, unknown>) =>
    sys(async (tx) => (await tx.query<{ id: string; summary: string; args_preview: Record<string, unknown>; status: string }>('SELECT id, summary, args_preview, status FROM app.approvals WHERE id = $1', [answer['approvalId']])).rows[0]!);
  async function approve(id: string): Promise<void> {
    const res = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${id}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await until(async () => (await sys(async (tx) => (await tx.query<{ outcome: string | null }>('SELECT outcome FROM app.approvals WHERE id = $1', [id])).rows[0]!.outcome)) === 'ran' || null, 30_000, 'the approval to be marked as run');
  }

  beforeAll(async () => {
    fake.signInAs(asker.email);
    const mine = fake.account(asker.email);
    mine.mails.push({ id: 'mail-archived', from: 'billing@harbourgrain.example', to: asker.email, subject: 'Receipt for invoice 2040', date: '2026-09-30T09:00:00Z', text: 'Thanks, paid.\n', folder: 'archive', categories: ['Customer'], isRead: true });
    mine.files.push({ id: 'file-sheet', name: 'Cost sheet.xlsx', mimeType: SHEET_MIME, modified: '2026-10-21T10:00:00.000Z', text: 'item,cost\nservers,420\nbackups,65\n' });
    mine.siteFiles = [{ id: 'site-policy', name: 'Travel policy.md', mimeType: 'text/markdown', modified: '2026-10-02T08:00:00.000Z', text: '# Travel policy\n\nBook trains before planes.\n' }];
    bot = await makeBot(ENG, 'microsoft-depth', [{ connection: 'person:*', tools: MICROSOFT_TOOLS_ALL }]);
    await compile(ENG, bot.botId);
    await connect(asker, 'microsoft', ['mail', 'onedrive', 'calendar']);
  });

  it('offers the new tools only for the services the person agreed to, and says what to do when one is called without it', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const before = await listed(run);
    for (const name of NEW_TOOLS.filter((n) => n !== 'outlook.list_folders')) expect(before, name).not.toContain(name);
    expect(before).toContain('outlook.search');
    expect(before).toContain('outlook.list_folders'); // a read of the Outlook mail service
    const answer = await called(run, 'outlook_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-11-03T12:00:00Z' });
    expect(answer).toMatchObject({ ok: false, code: 'not_agreed' });
    expect(fake.outlookSent).toEqual([]);

    await connect(asker, 'microsoft', WIDE);
    const after = await listed(await openRun(bot.botId, ENG, asker.actorId));
    for (const name of NEW_TOOLS) expect(after, name).toContain(name);
  });

  it('the consent page asks for the new scopes only when the person ticks them (incremental)', () => {
    const consents = fake.consents.filter((c) => c.provider === 'microsoft');
    expect(consents.at(-1)!.scopes).toEqual(expect.arrayContaining(['Mail.Send', 'Mail.ReadWrite', 'MailboxSettings.Read', 'Calendars.ReadBasic', 'Calendars.ReadWrite', 'Sites.Read.All']));
    expect(consents.at(-2)!.scopes.join(' ')).not.toContain('Mail.Send');
  });

  it('search by sender, date, subject, category and folder; the folders and the categories of the mailbox list', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const subjects = async (args: Record<string, unknown>) => ((await called(run, 'outlook.search', args))['messages'] as Array<{ subject: string }>).map((m) => m.subject);
    expect(await subjects({ from: 'billing@harbourgrain.example', after: '2026-10-01T00:00:00Z' })).toEqual(['Invoice 2041 is overdue']);
    expect(await subjects({ subject: 'receipt' })).toEqual(['Receipt for invoice 2040']);
    expect(await subjects({ category: 'customer' })).toEqual(['Receipt for invoice 2040']);
    expect(await subjects({ folder: 'archive' })).toEqual(['Receipt for invoice 2040']);
    expect(await subjects({ unreadOnly: true, before: '2026-12-01T00:00:00Z' })).toEqual(['Invoice 2041 is overdue', 'Offsite venue']);
    expect(await subjects({ query: 'invoice', unreadOnly: true })).toEqual(['Invoice 2041 is overdue']);
    expect(await called(run, 'outlook.search', {})).toMatchObject({ code: 'validation_failed' });
    expect(await called(run, 'outlook.read', { messageId: 'mail-archived' })).toMatchObject({ ok: true, categories: ['Customer'], unread: false, folderId: 'archive' });
    const folders = (await called(run, 'outlook.list_folders'))['folders'] as Array<{ id: string; name: string }>;
    expect(folders.map((f) => f.id)).toEqual(expect.arrayContaining(['inbox', 'archive']));
    expect(((await called(run, 'outlook.list_categories'))['categories'] as Array<{ name: string }>).map((c) => c.name)).toEqual(['Customer', 'Urgent', 'Offsite']);
  });

  it('a category change waits for approval with a card, then runs once and keeps the other categories', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const answer = await called(run, 'outlook.categorize', { messageId: 'mail-archived', add: ['urgent'] });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.categoryChanges).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toBe('Categorise a message: add urgent, remove nothing');
    await approve(card.id);
    expect(fake.categoryChanges).toEqual([{ account: asker.email, messageId: 'mail-archived', categories: ['Customer', 'Urgent'] }]);
  });

  it('a message goes out only after the person approves it, to the addresses on the card, with no bcc', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const answer = await called(run, 'outlook.send', { to: ['billing@harbourgrain.example'], cc: [omar.email], subject: 'Invoice 2041', body: `We will pay on Friday.\n${'x'.repeat(1600)}` });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.outlookSent).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toContain('billing@harbourgrain.example');
    expect(card.summary).toContain(`cc ${omar.email}`);
    expect(card.args_preview).toMatchObject({ to: ['billing@harbourgrain.example'], cc: [omar.email], subject: 'Invoice 2041' });
    // the approvals store keeps 300 characters of a text and says so; the card the tool builds holds 1,500 (unit-tested) and the full call is one click away
    expect(String(card.args_preview['body']).startsWith('We will pay on Friday.')).toBe(true);
    await approve(card.id);
    expect(fake.outlookSent).toHaveLength(1);
    expect(fake.outlookSent[0]).toMatchObject({ account: asker.email, to: ['billing@harbourgrain.example'], cc: [omar.email], bcc: [], replyTo: [], subject: 'Invoice 2041', viaReply: false, inReplyTo: null });
    expect(fake.outlookSent[0]!.body.startsWith('We will pay on Friday.')).toBe(true);
  });

  it('an answer to a message goes through a reply in its conversation, and what is sent is what the card showed', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const answer = await called(run, 'outlook.send', { to: ['billing@harbourgrain.example'], subject: 'RE: Invoice 2041 is overdue', body: 'Paid on Friday.', replyToMessageId: 'mail-invoice' });
    expect(answer).toMatchObject({ code: 'approval_pending' });
    const card = await pendingOf(answer);
    expect(card.args_preview).toMatchObject({ inReplyTo: 'mail-invoice' });
    const sent = fake.outlookSent.length;
    await approve(card.id);
    expect(fake.outlookSent).toHaveLength(sent + 1);
    expect(fake.outlookSent.at(-1)).toMatchObject({ account: asker.email, to: ['billing@harbourgrain.example'], cc: [], bcc: [], replyTo: [], subject: 'RE: Invoice 2041 is overdue', body: 'Paid on Friday.', viaReply: true, inReplyTo: 'mail-invoice' });
  });

  it('refuses a send that could add a header or a hidden recipient, before anything is asked of Microsoft', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const calls = fake.apiCalls.length;
    const sent = fake.outlookSent.length;
    for (const args of [
      { to: ['a@b.co\r\nBcc: spy@evil.example'], subject: 's', body: 'b' },
      { to: ['a@b.co'], subject: 'x\r\nBcc: spy@evil.example', body: 'b' },
      { to: ['a@b.co'], bcc: ['spy@evil.example'], subject: 's', body: 'b' },
      { to: ['a@b.co'], replyTo: ['spy@evil.example'], subject: 's', body: 'b' },
      { to: ['é@b.co'], subject: 's', body: 'b' },
      { to: ['a@b.co'], subject: 's', body: 'b', replyToMessageId: '..' },
    ]) {
      const answer = await called(run, 'outlook.send', args);
      expect(['validation_failed', 'approval_pending']).toContain(answer['code']);
    }
    expect(fake.apiCalls.length).toBe(calls);
    expect(fake.outlookSent.length).toBe(sent);
  });

  it('free and busy: busy spans only, a calendar that is not visible said so and what the provider said about it kept out', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const answer = await called(run, 'outlook_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-11-03T12:00:00Z', people: [omar.email, 'stranger@elsewhere.example'], minMinutes: 30 });
    expect(answer['calendars']).toEqual([
      { who: 'you', visible: true, busy: [{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T09:15:00.000Z' }] },
      { who: omar.email, visible: true, busy: [{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T09:15:00.000Z' }] },
      { who: 'stranger@elsewhere.example', visible: false, busy: [] },
    ]);
    expect(answer['free']).toEqual([
      { start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T09:00:00.000Z' },
      { start: '2026-11-03T09:15:00.000Z', end: '2026-11-03T12:00:00.000Z' },
    ]);
    expect(answer['freeCoversEveryone']).toBe(false);
    expect(fake.scheduleRequests.at(-1)!.schedules).toEqual([asker.email, omar.email, 'stranger@elsewhere.example']);
    expect(JSON.stringify(answer)).not.toMatch(/stand-up|SECRET/);
    expect(await called(run, 'outlook_calendar.free_busy', { from: '2026-11-03T00:00:00Z', to: '2027-03-03T00:00:00Z' })).toMatchObject({ code: 'validation_failed' });
  });

  it('changing an event waits for approval, then changes only what was named, in UTC', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const answer = await called(run, 'outlook_calendar.update_event', { eventId: 'event-standup', title: 'Team stand-up (moved)', start: '2026-11-03T09:30:00+00:00', end: '2026-11-03T09:45:00+00:00' });
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    expect(fake.outlookEventUpdates).toEqual([]);
    const card = await pendingOf(answer);
    expect(card.summary).toBe('Change event event-standup: title, start, end');
    await approve(card.id);
    expect(fake.outlookEventUpdates).toEqual([
      { account: asker.email, eventId: 'event-standup', fields: { subject: 'Team stand-up (moved)', start: { dateTime: '2026-11-03T09:30:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-03T09:45:00', timeZone: 'UTC' } } },
    ]);
  });

  it('SharePoint finds and reads a file by drive and item; a workbook in OneDrive reads as CSV', async () => {
    const run = await openRun(bot.botId, ENG, asker.actorId);
    const found = (await called(run, 'sharepoint.search', { query: 'travel policy' }))['files'] as Array<{ driveId: string; itemId: string; name: string }>;
    expect(found).toEqual([expect.objectContaining({ driveId: 'b!site-docs', itemId: 'site-policy', name: 'Travel policy.md' })]);
    expect(await called(run, 'sharepoint.read', { driveId: found[0]!.driveId, itemId: found[0]!.itemId })).toMatchObject({ ok: true, text: expect.stringContaining('Book trains before planes') });
    expect(await called(run, 'sharepoint.read', { driveId: 'b!site-docs', itemId: 'nope' })).toMatchObject({ ok: false });
    expect(await called(run, 'onedrive.read', { itemId: 'file-sheet' })).toMatchObject({ ok: true, type: 'text/csv', text: 'item,cost\nservers,420\nbackups,65' });
    expect(JSON.stringify(found)).not.toContain('SECRET-SUMMARY');
  });

  it('a token appears in no answer and no card, and no mailbox text in an error', async () => {
    const cards = await sys(async (tx) => JSON.stringify((await tx.query('SELECT summary, args_preview FROM app.approvals')).rows));
    expect(`${answers.join('\n')}\n${cards}`).not.toMatch(/(access|refresh)-[A-Za-z0-9_-]{20}/);
    expect(answers.join('\n')).not.toContain('SECRET-MAILBOX-TEXT');
  });
});

// The test every source of tools must pass (bot capabilities ∩ asker visibility), run for a read and for a write of a person's connection.
describe('intersection', () => {
  let bot: { botId: string; actorId: string };
  const state = { askerVisible: true };

  const subjectFor = (tool: string, kind: 'read' | 'write', args: Record<string, unknown>) => () => ({
    tool,
    kind,
    async arrange(next: { botGranted: boolean; askerVisible: boolean }): Promise<void> {
      state.askerVisible = next.askerVisible;
      await setBotConnections(bot.botId, next.botGranted ? [{ connection: 'person:*', tools: [tool] }] : []);
      await compile(ENG, bot.botId);
    },
    async listed(): Promise<readonly string[]> {
      return listed(await runForAsker());
    },
    async call(): Promise<CallOutcome> {
      const answer = await called(await runForAsker(), tool, args);
      const code = typeof answer['code'] === 'string' ? answer['code'] : undefined;
      return { refused: code === 'forbidden' || code === 'not_found' || code === 'unknown_tool', code, text: JSON.stringify(answer) };
    },
  });

  /** The asker (sameera, who is on no team) is seated just long enough to open the run, then seated or not as the case says. */
  async function runForAsker(): Promise<McpRunMintResponse> {
    const seat = (on: boolean) =>
      sys((tx) =>
        on
          ? tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`, [ENG, sameera.actorId, WS])
          : tx.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [ENG, sameera.actorId]),
      );
    await seat(true);
    const run = await openRun(bot.botId, ENG, sameera.actorId);
    await seat(state.askerVisible);
    return run;
  }

  beforeAll(async () => {
    await connect(sameera, 'google', ['drive', 'calendar', 'calendar_write']);
    bot = await makeBot(ENG, 'person-intersect', []);
  });

  describeToolSourceIntersection('a person’s connection (a read: google_drive.search)', subjectFor('google_drive.search', 'read', { query: 'roadmap' }));
  describeToolSourceIntersection('a person’s connection (a write: google_calendar.create_event)', subjectFor('google_calendar.create_event', 'write', { title: 'Sync', start: '2026-11-06T10:00:00+00:00', end: '2026-11-06T11:00:00+00:00' }));
});
