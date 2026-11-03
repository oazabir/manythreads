import { createSecretService, createSystemPool, enqueue, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { ListOAuthAppsResponse, ListPersonConnectionsResponse, PutOAuthAppResponse, StartPersonConnectionResponse, type PersonProviderId } from '@manythreads/shared';
import { startFakeProviders, type FakeProviders } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld, type Who } from '../../repo-git/test/world.ts';
import { readConnectionSecret } from '../src/index.ts';
import { resolveApp } from '../src/oauth/apps.ts';
import { REFRESH_QUEUE } from '../src/oauth/refresh.ts';
import { accessTokenFor, type OAuthDeps } from '../src/oauth/store.ts';

// P16-02: the one OAuth helper, on a real server and the fake provider (packages/test-utils/src/fake-providers.ts; no real network): the OAuth apps an admin enters
// (sealed, never returned), incremental scopes, the renewal job and refresh-token rotation, connection health, the one-time "Reconnect" notice and its notification,
// and the revoke at the provider. What a real Google or Microsoft must still confirm is listed in docs/plugins/connections.md.

vi.setConfig({ testTimeout: 120_000 });

const { omar, nadia, rafi, priya, sameera, tariq } = personas;
const WS = omar.workspaceId;
const APP_SECRET = 'workspace-app-SECRET-7f3a9c1d5e2b4a60';

let w: RepoWorld;
let fake: FakeProviders;
let sysPool: pg.Pool;
let deps: OAuthDeps;
const savedEnv: Record<string, string | undefined> = {};

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: WS });
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const devHeader = (who: Who): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind ?? 'person', id: who.actorId, workspaceId: who.workspaceId }) });
const raw = (who: Who, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${w.server.url}${path}`, { method, redirect: 'manual', headers: { ...devHeader(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function begin(who: Who, provider: PersonProviderId, body: Record<string, unknown> = {}): Promise<string> {
  const res = await raw(who, 'POST', `/api/me/connections/${provider}/start`, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return StartPersonConnectionResponse.parse(await res.json()).url;
}
async function consent(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status, url).toBe(302);
  return new URL(res.headers.get('location')!);
}
async function arrive(who: Who, back: URL): Promise<URL> {
  const res = await raw(who, 'GET', `${back.pathname}${back.search}`);
  expect(res.status, await res.clone().text()).toBe(302);
  return new URL(res.headers.get('location')!, 'http://site.invalid');
}
async function connect(who: Who & { email: string }, provider: PersonProviderId, services?: string[]): Promise<URL> {
  fake.signInAs(who.email);
  return arrive(who, await consent(await begin(who, provider, services ? { services } : {})));
}
const providerOf = async (who: Who, id: PersonProviderId) => {
  const res = await w.call(who, 'GET', '/api/me/connections/providers');
  expect(res.status).toBe(200);
  return ListPersonConnectionsResponse.parse(res.body).providers.find((p) => p.id === id)!;
};
const connectionOf = (who: { actorId: string }, provider: PersonProviderId) =>
  sys(async (tx) =>
    (
      await tx.query<{ id: string; state: string; status: string; failures: number; last_problem: string | null; notified_at: Date | null; access_expires_at: Date; refreshed_at: Date; scopes: string[] }>(
        `SELECT c.id, c.status, o.state, o.failures, o.last_problem, o.notified_at, o.access_expires_at, o.refreshed_at, o.scopes
           FROM app.connections c JOIN app.connection_oauth o ON o.connection_id = c.id WHERE c.owner_id = $1 AND c.slug = $2`,
        [who.actorId, provider],
      )
    ).rows[0],
  );
const secretOf = (connectionId: string, name: 'access_token' | 'refresh_token') => readConnectionSecret(deps, { workspaceId: WS, connectionId, name });
const secretRows = () => sys(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.secrets')).rows[0]!.n);
const setExpiry = (connectionId: string, interval: string) => sys((tx) => tx.query(`UPDATE app.connection_oauth SET access_expires_at = now() + $2::interval WHERE connection_id = $1`, [connectionId, interval]));
const refreshCalls = (provider: PersonProviderId) => fake.tokenCalls.filter((c) => c.provider === provider && c.grant === 'refresh_token');

/** Runs the renewal job once, through the server's own job queue, and waits for it to finish. */
async function runRefreshJob(): Promise<void> {
  const id = await w.system(async (tx) => (await enqueue(tx, REFRESH_QUEUE, {})).id);
  await until(async () => {
    const row = (await w.system(async (tx) => (await tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id])).rows[0]))!;
    if (row.state === 'dead') throw new Error(`the renewal job failed: ${row.last_error ?? ''}`);
    return row.state === 'done';
  }, 30_000, 'the renewal job');
}

const eventsOf = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const appStatus = async (): Promise<ReturnType<typeof ListOAuthAppsResponse.parse>['apps'][number]> => {
  const res = await w.call(omar, 'GET', '/api/admin/connections/oauth-apps');
  expect(res.status).toBe(200);
  return ListOAuthAppsResponse.parse(res.body).apps.find((a) => a.provider === 'google')!;
};

beforeAll(async () => {
  fake = await startFakeProviders();
  for (const [k, v] of Object.entries(fake.env())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
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

describe('the OAuth apps an admin enters', () => {
  const put = (who: Who, provider: string, body: unknown) => w.call(who, 'PUT', `/api/admin/connections/oauth-apps/${provider}`, body);

  it('are for workspace admins only', async () => {
    expect((await w.call(null, 'GET', '/api/admin/connections/oauth-apps')).status).toBe(401);
    for (const who of [nadia, tariq]) {
      expect((await w.call(who, 'GET', '/api/admin/connections/oauth-apps')).status).toBe(403);
      expect((await put(who, 'google', { clientId: 'x', clientSecret: APP_SECRET })).status).toBe(403);
      expect((await w.call(who, 'DELETE', '/api/admin/connections/oauth-apps/google')).status).toBe(403);
    }
    expect(await appStatus()).toMatchObject({ source: 'server', hasSecret: true, clientId: null });
  });

  it('seal the secret and show only that one is stored: it comes back from no route, event or row', async () => {
    const sealedBefore = await secretRows();
    const res = await put(omar, 'google', { clientId: fake.clientId, clientSecret: APP_SECRET });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const app = PutOAuthAppResponse.parse(res.body).app;
    expect(app).toMatchObject({ provider: 'google', source: 'workspace', clientId: fake.clientId, hasSecret: true, supportsTenant: false, tenant: null });
    expect(app.redirectUri).toMatch(/\/api\/me\/connections\/google\/callback$/);
    expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
    expect(JSON.stringify((await w.call(omar, 'GET', '/api/admin/connections/oauth-apps')).body)).not.toContain(APP_SECRET);
    expect(await appStatus()).toMatchObject({ source: 'workspace', clientId: fake.clientId, hasSecret: true });

    // stored sealed: a pointer row, one more sealed row, and the plaintext in no column of the apps table and not in the sealed bytes
    expect(await secretRows()).toBe(sealedBefore + 1);
    const stored = await sys(async (tx) => ({
      apps: JSON.stringify((await tx.query(`SELECT row_to_json(a) AS r FROM app.connection_oauth_apps a`)).rows),
      pointers: (await tx.query('SELECT 1 FROM app.connection_oauth_app_secrets')).rows.length,
      sealed: (await tx.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM app.secrets')).rows.map((r) => r.ciphertext),
    }));
    expect(stored.apps).not.toContain(APP_SECRET);
    expect(stored.pointers).toBe(1);
    for (const bytes of stored.sealed) {
      expect(bytes.toString('utf8')).not.toContain(APP_SECRET);
      expect(bytes.toString('latin1')).not.toContain(APP_SECRET);
    }
    // and the platform reads it back, for the one call that needs it
    expect(await resolveApp(deps, WS, 'google')).toMatchObject({ clientId: fake.clientId, clientSecret: APP_SECRET, source: 'workspace' });
  });

  it('refuse a bad body without echoing the secret, and a directory setting for a provider that has none', async () => {
    const bad = await put(omar, 'google', { clientSecret: APP_SECRET });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain(APP_SECRET);
    const extra = await put(omar, 'google', { clientId: 'x', clientSecret: APP_SECRET, surprise: APP_SECRET });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).not.toContain(APP_SECRET);
    const tenant = await put(omar, 'google', { clientId: 'x', clientSecret: APP_SECRET, tenant: 'contoso.com' });
    expect(tenant.status).toBe(400);
    expect(JSON.stringify(tenant.body)).not.toContain(APP_SECRET);
    expect((await put(omar, 'nope', { clientId: 'x', clientSecret: APP_SECRET })).status).toBe(400);
    expect(await appStatus()).toMatchObject({ source: 'workspace', clientId: fake.clientId });
  });

  it('write one event each, naming the provider and the change, with neither the client id nor the secret', async () => {
    const events = await eventsOf('connections.oauth_app.changed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'google', change: 'set', actorId: omar.actorId });
    expect(Object.keys(events[0]!).sort()).toEqual(['actorId', 'at', 'change', 'provider']);
    expect(JSON.stringify(events)).not.toContain(APP_SECRET);
    expect(JSON.stringify(events)).not.toContain(fake.clientId);
  });

  it('replacing the secret seals the new one and removes the old sealed row', async () => {
    const before = await secretRows();
    const next = `${APP_SECRET}-second`;
    expect((await put(omar, 'google', { clientId: fake.clientId, clientSecret: next })).status).toBe(200);
    expect(await secretRows()).toBe(before);
    expect(await resolveApp(deps, WS, 'google')).toMatchObject({ clientSecret: next });
    // put the working one back (the fake provider accepts only its own)
    expect((await put(omar, 'google', { clientId: fake.clientId, clientSecret: fake.clientSecret })).status).toBe(200);
  });

  it('a person’s sign-in uses the workspace’s app, not the server’s environment', async () => {
    const saved = { id: process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'], secret: process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET'] };
    process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'] = 'environment-app-id';
    process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET'] = 'environment-app-secret';
    try {
      const url = new URL(await begin(priya, 'google', { services: ['drive'] }));
      expect(url.searchParams.get('client_id')).toBe(fake.clientId);
      fake.signInAs(priya.email);
      const back = await arrive(priya, await consent(url.toString()));
      expect(back.searchParams.get('connected')).toBe('google');
      expect(fake.tokenCalls.at(-1)).toMatchObject({ provider: 'google', grant: 'authorization_code', ok: true, pkce: true });
    } finally {
      process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'] = saved.id;
      process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET'] = saved.secret;
    }
  });

  it('clearing removes the sealed secret too and hands back to the server’s environment', async () => {
    const before = await secretRows();
    const res = await w.call(omar, 'DELETE', '/api/admin/connections/oauth-apps/google');
    expect(res).toMatchObject({ status: 200, body: { cleared: true } });
    expect(await secretRows()).toBe(before - 1);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_oauth_app_secrets')).rows.length)).toBe(0);
    expect(await appStatus()).toMatchObject({ source: 'server', clientId: null });
    expect(await resolveApp(deps, WS, 'google')).toMatchObject({ source: 'server' });
    expect((await w.call(omar, 'DELETE', '/api/admin/connections/oauth-apps/google')).body).toEqual({ cleared: false });
    expect((await eventsOf('connections.oauth_app.changed')).map((e) => e['change'])).toEqual(['set', 'set', 'set', 'cleared']);
  });

  it('with no app at all, the provider is not configured and a sign-in says so', async () => {
    const saved = { id: process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'], secret: process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET'] };
    delete process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'];
    try {
      expect(await appStatus()).toMatchObject({ source: null, hasSecret: false, clientId: null });
      expect((await providerOf(omar, 'google')).configured).toBe(false);
      expect((await raw(omar, 'POST', '/api/me/connections/google/start', {})).status).toBe(409);
      // an admin puts one in and it is configured at once, with nothing in the environment
      expect((await put(omar, 'google', { clientId: fake.clientId, clientSecret: fake.clientSecret })).status).toBe(200);
      expect((await providerOf(omar, 'google')).configured).toBe(true);
    } finally {
      process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'] = saved.id;
      await w.call(omar, 'DELETE', '/api/admin/connections/oauth-apps/google');
    }
  });
});

describe('incremental scopes', () => {
  it('a later sign-in asks only for the new service, the provider keeps the earlier grants, and the person ends with both', async () => {
    // priya already agreed to Drive (above)
    const url = new URL(await begin(priya, 'google', { services: ['drive', 'gmail'] }));
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    fake.signInAs(priya.email);
    await arrive(priya, await consent(url.toString()));
    const p = await providerOf(priya, 'google');
    expect(p.services.filter((s) => s.granted).map((s) => s.id)).toEqual(['drive', 'gmail']);
    expect((await connectionOf(priya, 'google'))!.scopes).toEqual(expect.arrayContaining(['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/gmail.readonly']));
  });

  it('signing in again for what is already agreed to asks for it as it is (a person renewing on purpose)', async () => {
    const url = new URL(await begin(priya, 'google', { services: ['drive'] }));
    expect(url.searchParams.get('scope')!.split(' ')).toContain('https://www.googleapis.com/auth/drive.readonly');
  });
});

describe('keeping sign-ins alive by job', () => {
  it('renews a sign-in that ends soon, rotates the refresh token, and leaves a sign-in with time left alone', async () => {
    fake.setRotation('microsoft', true);
    await connect(rafi, 'microsoft');
    const mine = (await connectionOf(rafi, 'microsoft'))!;
    const accessBefore = await secretOf(mine.id, 'access_token');
    const refreshBefore = await secretOf(mine.id, 'refresh_token');
    const hers = (await connectionOf(priya, 'google'))!;
    await setExpiry(mine.id, '5 minutes');
    await setExpiry(hers.id, '3 hours');
    const herAccess = await secretOf(hers.id, 'access_token');
    const calls = refreshCalls('microsoft').length;
    const googleCalls = refreshCalls('google').length;

    await runRefreshJob();

    expect(refreshCalls('microsoft').length).toBe(calls + 1);
    expect(refreshCalls('google').length).toBe(googleCalls);
    expect(await secretOf(mine.id, 'access_token')).not.toBe(accessBefore);
    expect(await secretOf(mine.id, 'refresh_token')).not.toBe(refreshBefore);
    expect(await secretOf(hers.id, 'access_token')).toBe(herAccess);
    const after = (await connectionOf(rafi, 'microsoft'))!;
    expect(after.access_expires_at.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(after).toMatchObject({ state: 'ok', status: 'enabled', failures: 0, last_problem: null });
    // a second run finds nothing due
    await runRefreshJob();
    expect(refreshCalls('microsoft').length).toBe(calls + 1);
  });

  it('a provider that is down is counted on the connection and shown, nobody is told, and the next run that works clears it', async () => {
    const mine = (await connectionOf(rafi, 'microsoft'))!;
    await setExpiry(mine.id, '5 minutes');
    fake.failNextToken(503);
    await runRefreshJob();
    expect(await connectionOf(rafi, 'microsoft')).toMatchObject({ state: 'ok', status: 'enabled', failures: 1, last_problem: 'unavailable', notified_at: null });
    expect(await providerOf(rafi, 'microsoft')).toMatchObject({ state: 'ok', problem: 'unavailable', connected: true });
    expect((await providerOf(rafi, 'microsoft')).refreshedAt).not.toBeNull();
    expect(await eventsOf('connections.sign_in.expired')).toEqual([]);

    await runRefreshJob();
    expect(await connectionOf(rafi, 'microsoft')).toMatchObject({ state: 'ok', failures: 0, last_problem: null });
    expect(await providerOf(rafi, 'microsoft')).toMatchObject({ problem: null });
  });

  it('a sign-in the provider no longer honours turns off and the person gets one notice and one notification, however often it is found', async () => {
    await connect(sameera, 'google', ['drive']);
    const mine = (await connectionOf(sameera, 'google'))!;
    const noticesBefore = (await eventsOf('connections.sign_in.expired')).length;

    fake.revokeRefreshTokens();
    await setExpiry(mine.id, '5 minutes');
    await runRefreshJob();
    expect(await connectionOf(sameera, 'google')).toMatchObject({ state: 'needs_reconnect', status: 'disabled' });
    const notices = await until(async () => {
      const found = await eventsOf('connections.sign_in.expired');
      return found.length > noticesBefore ? found : null;
    }, 10_000, 'the notice');
    const notice = notices.at(-1)!;
    expect(notice).toMatchObject({ personId: sameera.personId, provider: 'google', connectionId: mine.id });
    // ids and the provider's short name only
    expect(Object.keys(notice).sort()).toEqual(['channelId', 'connectionId', 'messageId', 'personId', 'provider']);

    // the message in the person's Reminders conversation says what to do, and carries nothing else
    const message = (await w.system(async (tx) => (await tx.query<{ body_plain: string; channel_id: string }>('SELECT body_plain, channel_id FROM app.messages WHERE id = $1', [notice['messageId']])).rows[0]))!;
    expect(message.body_plain).toContain('Reconnect Google — access expired');
    expect(message.body_plain).not.toMatch(/(access|refresh)-[A-Za-z0-9_-]{20}/);
    expect(message.channel_id).toBe(notice['channelId']);
    const dm = (await w.system(async (tx) => (await tx.query<{ dm_key: string | null }>('SELECT dm_key FROM app.channels WHERE id = $1', [notice['channelId']])).rows[0]))!;
    expect(dm.dm_key).toMatch(/^reminders:/);

    // the bell
    const bell = await until(
      async () => (await w.system(async (tx) => (await tx.query<{ kind: string; ref_id: string; read_at: Date | null }>('SELECT kind, ref_id, read_at FROM app.notifications WHERE person_id = $1 AND ref_id = $2', [sameera.personId, notice['messageId']])).rows))[0],
      15_000,
      'the notification',
    );
    expect(bell).toMatchObject({ kind: 'reminder', read_at: null });
    const listed = await w.call(sameera, 'GET', '/api/notifications');
    expect(JSON.stringify(listed.body)).toContain('Reconnect Google');

    // found again (the sign-in put back on by hand, the person still not having reconnected): no second notice
    expect(await connectionOf(sameera, 'google')).toMatchObject({ notified_at: expect.any(Date) });
    await sys(async (tx) => {
      await tx.query(`UPDATE app.connection_oauth SET state = 'ok', access_expires_at = now() + interval '5 minutes' WHERE connection_id = $1`, [mine.id]);
      await tx.query(`UPDATE app.connections SET status = 'enabled' WHERE id = $1`, [mine.id]);
    });
    await runRefreshJob();
    expect(await connectionOf(sameera, 'google')).toMatchObject({ state: 'needs_reconnect' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await eventsOf('connections.sign_in.expired')).length).toBe(noticesBefore + 1);

    // the person reconnects: it works again and the next expiry is a new notice
    await connect(sameera, 'google', ['drive']);
    expect(await connectionOf(sameera, 'google')).toMatchObject({ state: 'ok', status: 'enabled', failures: 0, last_problem: null, notified_at: null });
    const again = (await connectionOf(sameera, 'google'))!;
    fake.revokeRefreshTokens();
    await setExpiry(again.id, '5 minutes');
    await runRefreshJob();
    await until(async () => (await eventsOf('connections.sign_in.expired')).length === noticesBefore + 2, 10_000, 'the second notice');
  });

  it('a call that finds the sign-in dead (the helper itself, without the notifier) switches it off and says so, and does not tell the person twice', async () => {
    await connect(tariq, 'google', ['drive']);
    const mine = (await connectionOf(tariq, 'google'))!;
    fake.revokeRefreshTokens();
    const calls = { n: 0 };
    const counting: OAuthDeps = { ...deps, onNeedsReconnect: async () => void (calls.n += 1) };
    await expect(accessTokenFor(counting, { id: mine.id, workspaceId: WS, provider: 'google' }, { force: true })).rejects.toMatchObject({ code: 'needs_reconnect' });
    await expect(accessTokenFor(counting, { id: mine.id, workspaceId: WS, provider: 'google' })).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect(await connectionOf(tariq, 'google')).toMatchObject({ state: 'needs_reconnect', status: 'disabled' });
    // the helper offers the hook every time it finds the sign-in dead; the notifier behind it writes once (proved by the job test above)
    expect(calls.n).toBe(2);
    // a hook that fails never changes the answer
    const failing: OAuthDeps = { ...deps, onNeedsReconnect: () => Promise.reject(new Error('the notice could not be written')) };
    await expect(accessTokenFor(failing, { id: mine.id, workspaceId: WS, provider: 'google' })).rejects.toMatchObject({ code: 'needs_reconnect' });
  });
});

describe('revoke on disconnect', () => {
  it('disconnecting asks the provider to forget the refresh token (with the workspace’s own app) and removes every sealed token', async () => {
    expect((await w.call(omar, 'PUT', '/api/admin/connections/oauth-apps/google', { clientId: fake.clientId, clientSecret: fake.clientSecret })).status).toBe(200);
    await connect(nadia, 'google', ['drive']);
    const mine = (await connectionOf(nadia, 'google'))!;
    const sealed = await secretRows();
    const revoked = fake.revoked.length;
    expect(await w.call(nadia, 'DELETE', '/api/me/connections/google')).toMatchObject({ status: 200, body: { disconnected: true } });
    expect(fake.revoked.slice(revoked)).toEqual([{ provider: 'google', kind: 'refresh' }]);
    expect(await secretRows()).toBe(sealed - 2);
    expect(await connectionOf(nadia, 'google')).toBeUndefined();
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_secrets WHERE connection_id = $1', [mine.id])).rows.length)).toBe(0);
  });

  it('removing the connection by the general route does the same', async () => {
    await connect(nadia, 'google', ['drive']);
    const mine = (await connectionOf(nadia, 'google'))!;
    const revoked = fake.revoked.length;
    const res = await w.call(nadia, 'DELETE', `/api/connections/${mine.id}`);
    expect(res).toMatchObject({ status: 200, body: { deleted: true } });
    expect(fake.revoked.slice(revoked)).toEqual([{ provider: 'google', kind: 'refresh' }]);
    expect(await connectionOf(nadia, 'google')).toBeUndefined();
  });

  it('with no app left to revoke with, the disconnect still goes through and nothing is sent', async () => {
    await connect(nadia, 'google', ['drive']);
    const saved = { id: process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'], secret: process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET'] };
    delete process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'];
    try {
      expect((await w.call(omar, 'DELETE', '/api/admin/connections/oauth-apps/google')).body).toEqual({ cleared: true });
      const revoked = fake.revoked.length;
      expect(await w.call(nadia, 'DELETE', '/api/me/connections/google')).toMatchObject({ status: 200, body: { disconnected: true } });
      expect(fake.revoked.length).toBe(revoked);
      expect(await connectionOf(nadia, 'google')).toBeUndefined();
    } finally {
      process.env['MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID'] = saved.id;
    }
  });
});

describe('no token or app secret leaks', () => {
  it('none is in the server log, any event, any answer the fake provider saw, or the notice', async () => {
    const pattern = /(access|refresh)-[A-Za-z0-9_-]{20}/;
    expect(w.server.logs.join('\n')).not.toMatch(pattern);
    expect(w.server.logs.join('\n')).not.toContain(APP_SECRET);
    expect(w.server.logs.join('\n')).not.toContain(fake.clientSecret);
    expect(JSON.stringify(fake.apiCalls)).not.toMatch(pattern);
    const events = await w.system(async (tx) => JSON.stringify((await tx.query(`SELECT payload FROM app.events WHERE type LIKE 'connections.%'`)).rows));
    expect(events).not.toMatch(pattern);
    expect(events).not.toContain(APP_SECRET);
    expect(events).not.toContain(fake.clientSecret);
    const messages = await w.system(async (tx) => JSON.stringify((await tx.query(`SELECT body_plain FROM app.messages WHERE body_plain LIKE 'Reconnect%'`)).rows));
    expect(messages).not.toMatch(pattern);
  });
});
