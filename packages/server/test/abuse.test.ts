import { readFileSync } from 'node:fs';
import { createRateLimiter } from '@manythreads/kernel';
import { ABUSE_ROUTES, ErrorEnvelope, type AbuseRoute } from '@manythreads/shared';
import {
  NADIA,
  OMAR,
  PERSONA_PASSWORD,
  RAFI,
  TARIQ,
  createApiClient,
  createPersonas,
  startTestServer,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/build-server.ts';

// PLAN D5 / P10-14: every route that grants, recovers or changes a credential or a session has an explicit low limit. These tests walk the one
// list of them (ABUSE_ROUTES), burst each past its limit and expect 429 with `retry-after`, then check the lockouts and that a made-up
// X-Forwarded-For cannot reset a counter. docs/deploy/rate-limits.md must carry the same numbers.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MINUTE = 60_000;
const UUID = '00000000-0000-7000-8000-000000000001';

/** A clock the tests move by hand; the server, its sessions, its lockouts and its rate limiter all read it. */
function fakeClock(start = new Date()) {
  const clock = { t: start.getTime(), now: () => new Date(clock.t), advance: (ms: number) => void (clock.t += ms) };
  return clock;
}

describe('the client address behind a proxy decides the counter, and a made-up header does not move it', () => {
  const probeConfig = { public: true, rateLimit: { limit: 3, windowMs: MINUTE }, rateLimitBy: 'address' } as const;
  const make = (trustProxy: boolean | number, clientAddressHeader?: string) =>
    buildServer({
      trustProxy,
      ...(clientAddressHeader ? { clientAddressHeader } : {}),
      devAuth: true,
      limiter: createRateLimiter(),
      routes: (a) => {
        a.get('/probe', { config: probeConfig }, () => ({ ok: true }));
        a.get('/probe-actor', { config: { public: true, rateLimit: { limit: 3, windowMs: MINUTE } } }, () => ({ ok: true }));
      },
    });
  const hit = async (app: Awaited<ReturnType<typeof make>>, xff: string | undefined, peer = '10.0.0.1', url = '/probe', headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, remoteAddress: peer, headers: { ...(xff ? { 'x-forwarded-for': xff } : {}), ...headers } });

  it('no proxy configured: the header is ignored, so rotating it never resets the counter', async () => {
    const app = await make(false);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await hit(app, `198.51.100.${i}`)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    const limited = await hit(app, '198.51.100.99');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('one proxy hop: only the entry the proxy appended counts; what the client wrote in front is ignored', async () => {
    const app = await make(1);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await hit(app, `spoof-${i}, 203.0.113.9`)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    // A genuinely different client (a different appended entry) has its own counter.
    expect((await hit(app, 'spoof-0, 203.0.113.10')).statusCode).toBe(200);
    await app.close();
  });

  it('two hops, as the chart is set (Traefik, then the web pod nginx): the client is the entry before both proxies', async () => {
    const app = await make(2);
    const statuses: number[] = [];
    // client 203.0.113.9 -> Traefik (appends 203.0.113.9) -> nginx (appends Traefik 10.1.1.1) -> server (peer nginx)
    for (let i = 0; i < 6; i++) statuses.push((await hit(app, `spoof-${i}, 203.0.113.9, 10.1.1.1`, '10.2.2.2')).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expect((await hit(app, 'spoof-0, 203.0.113.10, 10.1.1.1', '10.2.2.2')).statusCode).toBe(200);
    await app.close();
  });

  it('every visitor looks like the cluster bridge (the live finding): the forwarded chain cannot tell them apart, a trusted client-address header does', async () => {
    // k3s with externalTrafficPolicy Cluster: Traefik sees 10.42.0.1 for everybody and its X-Forwarded-For says so, whatever the hop count.
    const chain = '10.42.0.1, 10.42.0.163'; // as the server receives it: Traefik's view, then nginx appended Traefik
    const plain = await make(3);
    const shared: number[] = [];
    for (let i = 0; i < 4; i++) shared.push((await hit(plain, chain, '10.42.0.200', '/probe', { 'cf-connecting-ip': `198.51.100.${i}` })).statusCode);
    expect(shared, 'without the header every visitor shares one counter').toEqual([200, 200, 200, 429]);
    await plain.close();

    const app = await make(3, 'cf-connecting-ip');
    const own: number[] = [];
    for (let i = 0; i < 4; i++) own.push((await hit(app, chain, '10.42.0.200', '/probe', { 'cf-connecting-ip': `198.51.100.${i}` })).statusCode);
    expect(own, 'with the header each visitor has a counter').toEqual([200, 200, 200, 200]);
    const same: number[] = [];
    for (let i = 0; i < 5; i++) same.push((await hit(app, chain, '10.42.0.200', '/probe', { 'cf-connecting-ip': '198.51.100.77' })).statusCode);
    expect(same).toEqual([200, 200, 200, 429, 429]);
    // a header that is not exactly one address is ignored (the chain decides again, so these all share the cluster's counter), never used as a key
    const bad: number[] = [];
    for (const value of ['not-an-ip', '1.2.3.4, 5.6.7.8', '999.1.1.1', '']) bad.push((await hit(app, chain, '10.42.0.200', '/probe-actor', { 'cf-connecting-ip': value })).statusCode);
    expect(bad).toEqual([200, 200, 200, 429]);
    await app.close();
  });

  it('an IPv6 client is counted by its /64, and the mapped IPv4 form is the IPv4 address', async () => {
    const app = await make(false, 'cf-connecting-ip');
    const v6: number[] = [];
    for (let i = 0; i < 5; i++) v6.push((await hit(app, undefined, '10.0.0.1', '/probe', { 'cf-connecting-ip': `2001:db8:1:2:${i}::${i + 1}` })).statusCode);
    expect(v6).toEqual([200, 200, 200, 429, 429]);
    expect((await hit(app, undefined, '10.0.0.1', '/probe', { 'cf-connecting-ip': '2001:db8:1:3::1' })).statusCode).toBe(200);
    const a = await hit(app, undefined, '10.0.0.1', '/probe', { 'cf-connecting-ip': '203.0.113.50' });
    const b = await hit(app, undefined, '10.0.0.1', '/probe', { 'cf-connecting-ip': '::ffff:203.0.113.50' });
    const c = await hit(app, undefined, '10.0.0.1', '/probe', { 'cf-connecting-ip': '203.0.113.50' });
    const d = await hit(app, undefined, '10.0.0.1', '/probe', { 'cf-connecting-ip': '::ffff:203.0.113.50' });
    expect([a, b, c, d].map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
    await app.close();
  });

  it('a route that counts per address ignores who is signed in; one that does not gives each person a counter', async () => {
    const app = await make(false);
    const actor = (n: number): Record<string, string> => ({
      'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: `00000000-0000-7000-8000-00000000d00${n}`, workspaceId: UUID }),
    });
    const byAddress: number[] = [];
    for (let i = 1; i <= 5; i++) byAddress.push((await hit(app, undefined, '10.0.0.1', '/probe', actor(i))).statusCode);
    expect(byAddress).toEqual([200, 200, 200, 429, 429]);
    const byPerson: number[] = [];
    for (let i = 1; i <= 5; i++) byPerson.push((await hit(app, undefined, '10.0.0.1', '/probe-actor', actor(i))).statusCode);
    expect(byPerson).toEqual([200, 200, 200, 200, 200]);
    await app.close();
  });
});

describe('every credential route carries its listed limit and answers 429 with retry-after past it', () => {
  const clock = fakeClock();
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({
      now: clock.now,
      limiter: createRateLimiter({ now: () => clock.t }),
      trustProxy: 1,
      publicUrl: 'https://manythreads.example',
      testAuthToken: 'abuse-test-auth-token-0123456789',
    });
    await createPersonas(s.db);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  let nextAddress = 10;
  const freshAddress = (): string => `198.51.100.${nextAddress++}`;
  const urlOf = (r: AbuseRoute): string => r.path.replace(/:[A-Za-z]+/g, UUID);
  const actorHeader = JSON.stringify({ kind: 'person', id: OMAR.actorId, workspaceId: OMAR.workspaceId });
  const send = (r: AbuseRoute, address: string): Promise<Response> =>
    fetch(s.url + urlOf(r), {
      method: r.method,
      headers: {
        'x-forwarded-for': address,
        ...(r.key === 'person' ? { 'x-manythreads-dev-actor': actorHeader } : {}),
        ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(r.method === 'GET' ? {} : { body: '{}' }),
      redirect: 'manual',
    });

  const bursts = ABUSE_ROUTES.filter((r) => r.key !== 'failures' && !r.path.startsWith('/hooks/'));
  it.each(bursts.map((r) => [`${r.method} ${r.path}`, r] as const))('%s: the limit passes, the next call is 429 with retry-after, the window frees it', async (_name, r) => {
    const address = freshAddress();
    const statuses: number[] = [];
    for (let i = 0; i < r.limit; i++) statuses.push((await send(r, address)).status);
    expect(statuses.filter((x) => x === 429), 'no refusal inside the limit').toEqual([]);

    const over = await send(r, address);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(ErrorEnvelope.parse(await over.json()).error.code).toBe('rate_limited');

    // The window frees the address (a refused-token lock, where the route has one, holds 15 minutes: let that pass too).
    clock.advance(Math.max(r.windowMs + 1_000, 16 * MINUTE));
    expect((await send(r, address)).status).not.toBe(429);
  });

  it('a signed-in caller gets no second counter on a route that counts per address', async () => {
    const r = ABUSE_ROUTES.find((x) => x.path === '/api/auth/password/reset-request');
    if (!r) throw new Error('route missing from the list');
    const address = freshAddress();
    for (let i = 0; i < r.limit; i++) await send(r, address);
    const signedIn = await fetch(s.url + r.path, {
      method: 'POST',
      headers: { 'x-forwarded-for': address, 'content-type': 'application/json', 'x-manythreads-dev-actor': actorHeader },
      body: '{}',
    });
    expect(signedIn.status).toBe(429);
    clock.advance(2 * MINUTE);
  });

  it('wrong bot, run and pairing tokens: 60 failures per address a minute answer 401, the next ones 429 with retry-after', async () => {
    const bad = { authorization: 'Bearer forged-token-0123456789' };
    const post = (path: string, address: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: Record<string, string> = bad) =>
      fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address, ...headers }, body: JSON.stringify(body) });

    // /mcp on its own
    const a = freshAddress();
    const first = [];
    for (let i = 0; i < 60; i++) first.push((await post('/mcp', a)).status);
    expect(first.every((x) => x === 401)).toBe(true);
    const limited = await post('/mcp', a);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(ErrorEnvelope.parse(await limited.json()).error.code).toBe('rate_limited');
    // the bot's own address shares that counter; another client address does not
    expect((await post(`/api/mcp/bots/${UUID}`, a)).status).toBe(429);
    expect((await post('/mcp', freshAddress())).status).toBe(401);

    // wrong pairing tokens at the mint and wrong run tokens at the run path count together
    const b = freshAddress();
    for (let i = 0; i < 30; i++) expect((await post('/api/mcp/runs', b, { pairingToken: 'forged-pairing-token-0123' }, {})).status).toBe(401);
    for (let i = 0; i < 30; i++) expect((await post(`/api/mcp/runs/${UUID}`, b)).status).toBe(401);
    const over = await post(`/api/mcp/runs/${UUID}/close`, b, { status: 'done' });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // the model proxy for a run keeps its own failure counter
    const c = freshAddress();
    const proxy = (): Promise<Response> => post(`/api/llm/runs/${UUID}/v1/chat/completions`, c, { model: 'fast', messages: [] });
    const proxied = [];
    for (let i = 0; i < 60; i++) proxied.push((await proxy()).status);
    expect(proxied.every((x) => x === 401)).toBe(true);
    const proxyLimited = await proxy();
    expect(proxyLimited.status).toBe(429);
    expect(Number(proxyLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('calls to /hooks that name no live webhook lock the address after 30; a different address is not affected', async () => {
    const a = freshAddress();
    const call = (address: string): Promise<Response> =>
      fetch(`${s.url}/hooks/${UUID}/mtwh_wrongwrongwrongwrongwrong`, { method: 'POST', headers: { 'x-forwarded-for': address, 'content-type': 'application/json' }, body: '{}' });
    const first = [];
    for (let i = 0; i < 30; i++) first.push((await call(a)).status);
    expect(first.every((x) => x === 404)).toBe(true);
    const locked = await call(a);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(4 * 60);
    expect((await call(freshAddress())).status).toBe(404);
    clock.advance(6 * MINUTE);
    expect((await call(a)).status).toBe(404);
  });

  it('wrong test-sign-in tokens lock the address after 10; the right token from another address still works', async () => {
    const a = freshAddress();
    const attempt = (address: string, token: string): Promise<Response> =>
      fetch(`${s.url}/api/test/session`, {
        method: 'POST',
        headers: { 'x-forwarded-for': address, 'content-type': 'application/json', 'x-test-auth': token },
        body: JSON.stringify({ email: OMAR.email }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt(a, `wrong-token-${i}-0123456789`)).status).toBe(404);
    const locked = await attempt(a, 'abuse-test-auth-token-0123456789');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await attempt(freshAddress(), 'abuse-test-auth-token-0123456789')).status).toBe(200);
  });
});

describe('lockouts: temporary, per account, and never a permanent way to shut an owner out', () => {
  const clock = fakeClock();
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({
      now: clock.now,
      limiter: createRateLimiter({ now: () => clock.t }),
      trustProxy: 1,
      publicUrl: 'https://manythreads.example',
    });
    await createPersonas(s.db);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  let n = 10;
  const address = (): string => `192.0.2.${n++}`;
  const signIn = (from: string, email: string, password: string): Promise<Response> =>
    fetch(`${s.url}/api/auth/password/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
      body: JSON.stringify({ email, password }),
    });
  const message = async (res: Response): Promise<string> => ErrorEnvelope.parse(await res.json()).error.message;

  it('five wrong passwords lock that email + address for 15 minutes; another address is not affected; the lock ends by itself', async () => {
    const a = address();
    for (let i = 0; i < 5; i++) expect((await signIn(a, RAFI.email, `wrong-password-${i}x`)).status).toBe(401);
    const locked = await signIn(a, RAFI.email, PERSONA_PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
    expect(await message(locked)).toMatch(/Too many failed attempts\. Try again in \d+ minutes?\./);
    expect((await signIn(address(), RAFI.email, PERSONA_PASSWORD)).status).toBe(200);
    clock.advance(16 * MINUTE);
    expect((await signIn(a, RAFI.email, PERSONA_PASSWORD)).status).toBe(200);
  });

  it('guesses spread over many addresses lock the account itself; the lock expires, is not extended by hammering, and a reset link lifts it', async () => {
    // 25 failures from five addresses, five each: no address reaches a second lock, the account reaches its own.
    const spread = Array.from({ length: 5 }, address);
    for (const a of spread) for (let i = 0; i < 5; i++) await signIn(a, TARIQ.email, `wrong-password-${i}x`);
    clock.advance(2 * MINUTE);
    const fresh = address();
    const locked = await signIn(fresh, TARIQ.email, PERSONA_PASSWORD); // even the right password, from an address never seen
    expect(locked.status).toBe(429);
    expect(await message(locked)).toContain('on this account');
    const retry = Number(locked.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(12 * 60);
    expect(retry).toBeLessThanOrEqual(15 * 60);

    // Hammering while locked does not move the end of the lock.
    clock.advance(10 * MINUTE);
    for (let i = 0; i < 5; i++) expect((await signIn(fresh, TARIQ.email, `still-wrong-${i}x`)).status).toBe(429);
    clock.advance(4 * MINUTE);
    expect((await signIn(fresh, TARIQ.email, PERSONA_PASSWORD)).status).toBe(200); // 16 minutes after the lock began

    // A second lock, then the way back through the mailbox: a completed reset lifts the account's lock at once.
    const spread2 = Array.from({ length: 5 }, address);
    for (const a of spread2) for (let i = 0; i < 5; i++) await signIn(a, NADIA.email, `wrong-password-${i}x`);
    clock.advance(2 * MINUTE);
    expect((await signIn(address(), NADIA.email, PERSONA_PASSWORD)).status).toBe(429);
    const from = address();
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify(body) });
    expect((await post('/api/auth/password/reset-request', { email: NADIA.email })).status).toBe(202);
    const link = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(s.mailer.last(NADIA.email)?.text ?? '');
    expect(link?.[1]).toBeDefined();
    expect((await post('/api/auth/password/reset', { token: link?.[1], password: 'a-brand-new-passphrase' })).status).toBe(200);
    expect((await signIn(address(), NADIA.email, 'a-brand-new-passphrase')).status).toBe(200);
  });

  it('a second reset request inside a minute sends no second mail, and answers the same', async () => {
    const from = address();
    const request = (): Promise<Response> =>
      fetch(`${s.url}/api/auth/password/reset-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
        body: JSON.stringify({ email: OMAR.email }),
      });
    const before = s.mailer.to(OMAR.email).length;
    const one = await request();
    const two = await request();
    expect(one.status).toBe(202);
    expect(two.status).toBe(202);
    expect(await one.json()).toEqual(await two.json());
    expect(s.mailer.to(OMAR.email).length - before).toBe(1);
    clock.advance(2 * MINUTE);
    await request();
    expect(s.mailer.to(OMAR.email).length - before).toBe(2);
  });

  it('refused mailed links lock the client address: ten wrong ones, then 429 even for a right one, until the lock ends', async () => {
    const a = address();
    const reset = (token: string): Promise<Response> =>
      fetch(`${s.url}/api/auth/password/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': a },
        body: JSON.stringify({ token, password: 'another-new-passphrase' }),
      });
    for (let i = 0; i < 10; i++) {
      expect((await reset(`wrong-link-token-${i}-0123456789`)).status).toBe(410);
      if (i === 4) clock.advance(MINUTE + 1_000); // the route allows five a minute
    }
    clock.advance(MINUTE + 1_000);
    const locked = await reset('wrong-link-token-again-0123456789');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(10 * 60);
    expect(await message(locked)).toContain('Too many failed attempts with a link');
    clock.advance(16 * MINUTE);
    expect((await reset('wrong-link-token-last-0123456789')).status).toBe(410);
  });

  it('refused invitation tokens lock the client address the same way', async () => {
    const a = address();
    const look = (): Promise<Response> => fetch(`${s.url}/api/invitations/not-a-real-invitation-token-0123456789`, { headers: { 'x-forwarded-for': a } });
    for (let i = 0; i < 10; i++) expect((await look()).status).toBe(404);
    clock.advance(MINUTE + 1_000);
    const locked = await look();
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(10 * 60);
    clock.advance(16 * MINUTE);
    expect((await look()).status).toBe(404);
  });

  it('five wrong current passwords lock a password change for that person; the right one is refused until the lock ends', async () => {
    const c = createApiClient(s.url);
    const from = { 'x-forwarded-for': address() };
    expect((await c.post('/api/auth/password/sign-in', { email: OMAR.email, password: PERSONA_PASSWORD }, from)).status).toBe(200);
    const change = (current: string): Promise<Response> =>
      c.post('/api/auth/password/change', { currentPassword: current, newPassword: 'a-brand-new-passphrase' }, from);
    for (let i = 0; i < 5; i++) expect((await change(`wrong-current-${i}x`)).status).toBe(400);
    const limited = await change(PERSONA_PASSWORD); // inside the same minute: the route limit answers first
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    clock.advance(MINUTE + 1_000);
    const locked = await change(PERSONA_PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(10 * 60);
    expect(await message(locked)).toContain('Too many failed password guesses');
    // The session still works; only the change is held back.
    expect((await c.get('/api/auth/sessions', from)).status).toBe(200);
    clock.advance(16 * MINUTE);
    expect((await change(PERSONA_PASSWORD)).status).toBe(200);
  });
});

describe('docs/deploy/rate-limits.md carries the same numbers as the list', () => {
  const doc = readFileSync(new URL('../../../docs/deploy/rate-limits.md', import.meta.url), 'utf8');
  const rows = doc.split('\n').filter((l) => l.startsWith('| `'));
  it.each(ABUSE_ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))('%s is in the table with its limit and window', (_name, r) => {
    const row = rows.find((l) => l.startsWith(`| \`${r.method} ${r.path}\` |`));
    expect(row, 'a row for the route').toBeDefined();
    const cells = (row ?? '').split('|').map((c) => c.trim());
    // cells: '', route, before, limit, window, key, lockout
    expect(cells[3]).toBe(`${r.limit} per ${r.windowMs / 1000} s`);
    expect(cells[4]).toBe(`${r.windowMs / 1000} s`);
    expect(cells[5]).toBe(r.key);
  });
});
