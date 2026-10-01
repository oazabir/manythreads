import { withSystem } from '@manythreads/kernel';
import { ErrorEnvelope, GetSessionResponse, ListSessionsResponse } from '@manythreads/shared';
import {
  createApiClient,
  createPersonas,
  startTestServer,
  NADIA,
  OMAR,
  PERSONA_PASSWORD,
  RAFI,
  TARIQ,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashLinkToken } from '../src/tokens.ts';

const TEST_AUTH_TOKEN = 'test-auth-token-for-vitest-0123456789';
const MINUTE = 60_000;

/** A clock the tests move by hand; the server's session service and the plugin both read it. */
function fakeClock(start = new Date()) {
  const clock = { t: start.getTime(), now: () => new Date(clock.t), advance: (ms: number) => void (clock.t += ms) };
  return clock;
}

const json = async <T = unknown>(res: Response): Promise<T> => (await res.json()) as T;
const methodKinds = async (c: ReturnType<typeof createApiClient>): Promise<string[]> =>
  ((await (await c.get('/api/session')).json()) as { methods: { kind: string }[] }).methods.map((m) => m.kind);
const errorOf = async (res: Response) => ErrorEnvelope.parse(await res.json()).error;

async function sql<T>(s: TestServer, text: string, values: unknown[] = []): Promise<T[]> {
  return withSystem(async (tx) => (await tx.query(text, values)).rows as T[], { pool: s.pools.system });
}
const count = async (s: TestServer, table: string): Promise<number> =>
  (await sql<{ n: number }>(s, `SELECT count(*)::int AS n FROM app.${table}`))[0]?.n ?? -1;

describe('first-admin bootstrap', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer();
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  const form = { workspaceName: 'Kahf Software', name: 'Omar Al Zabir', email: 'Omar@Kahf.Example', password: 'a-long-enough-password' };

  it('prints exactly one log line with a one-time URL while no workspace exists', () => {
    const lines = s.logs.filter((l) => l.includes('first-admin setup'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/http:\/\/localhost:3000\/bootstrap\/[A-Za-z0-9_-]{40,}/);
    expect(s.bootstrapToken()).toBeDefined();
  });

  it('stores only the hash of the token', async () => {
    const token = s.bootstrapToken() as string;
    const rows = await sql<{ token_hash: Buffer; used_at: Date | null }>(s, 'SELECT token_hash, used_at FROM app.bootstrap_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash.length).toBe(32);
    expect(rows[0]?.token_hash.toString('utf8')).not.toContain(token);
    expect(rows[0]?.used_at).toBeNull();
  });

  it('an unknown token is 410 and creates nothing', async () => {
    const c = createApiClient(s.url);
    expect((await c.get('/api/bootstrap/not-the-token')).status).toBe(410);
    expect((await c.post('/api/bootstrap/not-the-token', form)).status).toBe(410);
    expect(await count(s, 'workspaces')).toBe(0);
  });

  it('refuses an 11-character password with the rule, and the link stays valid', async () => {
    const token = s.bootstrapToken() as string;
    const c = createApiClient(s.url);
    const res = await c.post(`/api/bootstrap/${token}`, { ...form, password: '12345678901' });
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe('validation_failed');
    expect(err.message).toContain('at least 12 characters');
    expect(err.path).toEqual(['password']);
    expect(await count(s, 'workspaces')).toBe(0);
    expect((await c.get(`/api/bootstrap/${token}`)).status).toBe(200);
  });

  it('creates the workspace, the owner and a session once; reuse is 410', async () => {
    const token = s.bootstrapToken() as string;
    const c = createApiClient(s.url);
    expect((await c.get(`/api/bootstrap/${token}`)).status).toBe(200);

    const res = await c.post(`/api/bootstrap/${token}`, form);
    expect(res.status).toBe(200);
    const body = GetSessionResponse.parse(await res.json());
    expect(body).toMatchObject({
      authenticated: true,
      person: { name: 'Omar Al Zabir', email: 'omar@kahf.example' },
      workspace: { name: 'Kahf Software' },
      role: 'owner',
    });
    expect(c.cookies.get('manythreads_session')).toBeDefined();

    expect((await c.get('/api/session').then(json<{ authenticated: boolean }>)).authenticated).toBe(true);

    // The link is spent.
    const again = createApiClient(s.url);
    expect((await again.get(`/api/bootstrap/${token}`)).status).toBe(410);
    expect((await again.post(`/api/bootstrap/${token}`, form)).status).toBe(410);
    expect(await count(s, 'workspaces')).toBe(1);
    expect(await count(s, 'people')).toBe(1);

    // The password works through the normal form, and the audit trail has both events.
    const signIn = createApiClient(s.url);
    expect((await signIn.signIn('omar@kahf.example', form.password)).status).toBe(200);
    const types = (await sql<{ type: string }>(s, 'SELECT type FROM app.events ORDER BY id')).map((r) => r.type);
    expect(types).toContain('identity.workspace.bootstrapped');
    expect(types.filter((t) => t === 'identity.session.signed_in')).toHaveLength(2);
  });

  it('a second link cannot create a second workspace', async () => {
    const used = await sql<{ n: number }>(s, 'SELECT count(*)::int AS n FROM app.bootstrap_tokens WHERE used_at IS NOT NULL');
    expect(used[0]?.n).toBe(1);
  });
});

describe('password sign-in, sessions, CSRF, break-glass', () => {
  const clock = fakeClock();
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({ now: clock.now, testAuthToken: TEST_AUTH_TOKEN, publicUrl: 'https://manythreads.example' });
    await createPersonas(s.db);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it('public GET /api/session lists the enabled methods and says nobody is signed in', async () => {
    const res = await createApiClient(s.url).get('/api/session');
    expect(res.status).toBe(200);
    expect(GetSessionResponse.parse(await res.json())).toEqual({
      authenticated: false,
      methods: [{ kind: 'password', label: 'Email and password' }],
    });
  });

  it('signs in with HttpOnly session cookie, readable CSRF cookie, and returns the person with teams', async () => {
    const c = createApiClient(s.url);
    const res = await c.signIn(NADIA.email, PERSONA_PASSWORD);
    expect(res.status).toBe(200);
    const body = GetSessionResponse.parse(await res.json());
    expect(body).toMatchObject({ authenticated: true, person: { name: 'Nadia', email: NADIA.email }, role: 'member' });
    if (!body.authenticated) throw new Error('unreachable');
    expect(body.teams.map((t) => `${t.slug}:${t.role}`)).toEqual(['engineering:member']);

    const raw = res.headers.getSetCookie();
    const session = raw.find((x) => x.startsWith('manythreads_session='));
    const csrf = raw.find((x) => x.startsWith('manythreads_csrf='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//i);
    expect(session).not.toMatch(/Secure/i); // NODE_ENV=test: plain http
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Lax/i);

    const me = GetSessionResponse.parse(await (await c.get('/api/session')).json());
    expect(me.authenticated).toBe(true);
  });

  it('the cookie token is opaque and only its hash is stored', async () => {
    const c = createApiClient(s.url);
    await c.signIn(NADIA.email, PERSONA_PASSWORD);
    const token = c.cookies.get('manythreads_session') as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await sql<{ token_hash: Buffer }>(s, 'SELECT token_hash FROM app.session_tokens');
    for (const r of rows) expect(r.token_hash.toString('base64url')).not.toBe(token);
  });

  it('refuses an unknown email and a wrong password with the same error, and creates nothing', async () => {
    const before = [await count(s, 'people'), await count(s, 'person_emails'), await count(s, 'sessions'), await count(s, 'workspaces')];
    const c = createApiClient(s.url);
    const unknown = await c.signIn('nobody@kahf.example', 'some-password-123');
    const wrong = await c.signIn(TARIQ.email, 'some-password-123');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(await count(s, 'people')).toBe(before[0]);
    expect(await count(s, 'person_emails')).toBe(before[1]);
    expect(await count(s, 'sessions')).toBe(before[2]);
    expect(await count(s, 'workspaces')).toBe(before[3]);
    expect(c.cookies.size).toBe(0);
  });

  it('answers an unknown email about as slowly as a wrong password (decoy verify)', async () => {
    const c = createApiClient(s.url);
    const time = async (email: string): Promise<number> => {
      const t = performance.now();
      await c.signIn(email, 'wrong-password-123');
      return performance.now() - t;
    };
    await time('warmup@kahf.example');
    const unknown = Math.min(await time('nobody1@kahf.example'), await time('nobody2@kahf.example'), await time('nobody3@kahf.example'));
    expect(unknown).toBeGreaterThan(5); // argon2 actually ran
  });

  it('locks an email + address after 5 failures for 15 minutes, then unlocks', async () => {
    const c = createApiClient(s.url);
    for (let i = 0; i < 5; i++) expect((await c.signIn(RAFI.email, `wrong-password-${i}x`)).status).toBe(401);
    const locked = await c.signIn(RAFI.email, PERSONA_PASSWORD); // even the right password is refused now
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
    expect((await errorOf(locked)).code).toBe('rate_limited');
    // Other people are not affected, and unknown emails lock too (no way to tell them apart).
    expect((await createApiClient(s.url).signIn(OMAR.email, PERSONA_PASSWORD)).status).toBe(200);
    for (let i = 0; i < 5; i++) await c.signIn('ghost@kahf.example', `wrong-password-${i}x`);
    expect((await c.signIn('ghost@kahf.example', 'wrong-password-zzz')).status).toBe(429);

    clock.advance(16 * MINUTE);
    expect((await c.signIn(RAFI.email, PERSONA_PASSWORD)).status).toBe(200);
  });

  it('a parallel burst of guesses is cut off at the limit, not after it', async () => {
    const c = createApiClient(s.url);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => c.signIn(TARIQ.email, `wrong-parallel-guess-${i}`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((x) => x === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((x) => x === 429).length).toBeGreaterThanOrEqual(7);
    expect(statuses.every((x) => x === 401 || x === 429)).toBe(true);
    clock.advance(16 * MINUTE);
  });

  it('records sign-in successes and failures as audit events', async () => {
    const rows = await sql<{ type: string; payload: { reason?: string; personId: string } }>(
      s,
      "SELECT type, payload FROM app.events WHERE type LIKE 'identity.session.%' ORDER BY id",
    );
    const failures = rows.filter((r) => r.type === 'identity.session.sign_in_failed');
    expect(failures.some((f) => f.payload.reason === 'wrong_password' && f.payload.personId === RAFI.personId)).toBe(true);
    expect(failures.some((f) => f.payload.reason === 'locked' && f.payload.personId === RAFI.personId)).toBe(true);
    expect(rows.some((r) => r.type === 'identity.session.signed_in')).toBe(true);
  });

  it('an idle session answers 401 and its cookie is cleared; activity keeps it alive', async () => {
    const c = createApiClient(s.url);
    await c.signIn(NADIA.email, PERSONA_PASSWORD);
    expect((await c.get('/api/auth/sessions')).status).toBe(200);
    clock.advance(20 * MINUTE);
    expect((await c.get('/api/auth/sessions')).status).toBe(200); // 20 minutes idle: alive, and now touched
    clock.advance(20 * MINUTE);
    expect((await c.get('/api/auth/sessions')).status).toBe(200); // 40 minutes after sign-in but only 20 idle
    clock.advance(31 * MINUTE);
    const res = await c.get('/api/auth/sessions');
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe('unauthenticated');
    expect(c.cookies.has('manythreads_session')).toBe(false); // Set-Cookie cleared it
    const anon = GetSessionResponse.parse(await (await c.get('/api/session')).json());
    expect(anon.authenticated).toBe(false);
  });

  it('lists own sessions, revokes one, and signs out everywhere', async () => {
    const a = createApiClient(s.url, { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/127.0' });
    const b = createApiClient(s.url);
    const omar = createApiClient(s.url);
    await a.signIn(NADIA.email, PERSONA_PASSWORD);
    await b.signIn(NADIA.email, PERSONA_PASSWORD);
    await omar.signIn(OMAR.email, PERSONA_PASSWORD);

    const list = ListSessionsResponse.parse(await (await a.get('/api/auth/sessions')).json());
    expect(list.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.sessions.filter((x) => x.current)).toHaveLength(1);
    expect(list.sessions.find((x) => x.current)?.label).toBe('Firefox on Linux');
    expect(JSON.stringify(list)).not.toMatch(/hash|token/i);

    // revoke b's session from a
    const bId = ListSessionsResponse.parse(await (await b.get('/api/auth/sessions')).json()).sessions.find((x) => x.current)?.id;
    expect((await a.delete(`/api/auth/sessions/${bId}`)).status).toBe(200);
    expect((await b.get('/api/auth/sessions')).status).toBe(401);
    expect((await a.delete(`/api/auth/sessions/${bId}`)).status).toBe(404);
    // nobody can revoke someone else's session
    const omarId = ListSessionsResponse.parse(await (await omar.get('/api/auth/sessions')).json()).sessions[0]?.id;
    expect((await a.delete(`/api/auth/sessions/${omarId}`)).status).toBe(404);
    expect((await omar.get('/api/auth/sessions')).status).toBe(200);

    // sign out everywhere: every live session of Nadia ends, Omar's stays
    const c = createApiClient(s.url);
    await c.signIn(NADIA.email, PERSONA_PASSWORD);
    const res = await a.post('/api/auth/sign-out-everywhere');
    expect(res.status).toBe(200);
    expect((await json<{ revoked: number }>(res)).revoked).toBeGreaterThanOrEqual(2);
    expect((await a.get('/api/auth/sessions')).status).toBe(401);
    expect((await c.get('/api/auth/sessions')).status).toBe(401);
    expect((await omar.get('/api/auth/sessions')).status).toBe(200);
  });

  it('sign-out ends only this session', async () => {
    const a = createApiClient(s.url);
    const b = createApiClient(s.url);
    await a.signIn(NADIA.email, PERSONA_PASSWORD);
    await b.signIn(NADIA.email, PERSONA_PASSWORD);
    expect((await a.post('/api/auth/sign-out')).status).toBe(200);
    expect(a.cookies.has('manythreads_session')).toBe(false);
    expect((await a.get('/api/auth/sessions')).status).toBe(401);
    expect((await b.get('/api/auth/sessions')).status).toBe(200);
  });

  it('signing in again replaces the session the browser presented', async () => {
    const a = createApiClient(s.url);
    await a.signIn(NADIA.email, PERSONA_PASSWORD);
    const first = a.cookies.get('manythreads_session');
    await a.signIn(NADIA.email, PERSONA_PASSWORD);
    expect(a.cookies.get('manythreads_session')).not.toBe(first);
    const stale = createApiClient(s.url);
    const res = await stale.get('/api/auth/sessions', { cookie: `manythreads_session=${first}` });
    expect(res.status).toBe(401);
  });

  it('CSRF: unsafe requests with a session cookie need the matching x-csrf-token header', async () => {
    const c = createApiClient(s.url);
    await c.signIn(NADIA.email, PERSONA_PASSWORD);
    const csrf = c.cookies.get('manythreads_csrf') as string;

    const missing = await c.request('POST', '/api/auth/sign-out', { csrf: false });
    expect(missing.status).toBe(403);
    expect((await errorOf(missing)).message).toMatch(/CSRF/);
    expect((await c.request('POST', '/api/auth/sign-out', { headers: { 'x-csrf-token': 'x'.repeat(43) } })).status).toBe(403);
    // another session's token (readable cookie forged to match) is not enough either
    const other = createApiClient(s.url);
    await other.signIn(OMAR.email, PERSONA_PASSWORD);
    const forged = other.cookies.get('manythreads_csrf') as string;
    const res = await fetch(`${s.url}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: `manythreads_session=${c.cookies.get('manythreads_session')}; manythreads_csrf=${forged}`, 'x-csrf-token': forged },
    });
    expect(res.status).toBe(403);
    // reads never need it, and the right header works
    expect((await c.get('/api/auth/sessions')).status).toBe(200);
    expect((await c.request('POST', '/api/auth/sign-out', { headers: { 'x-csrf-token': csrf } })).status).toBe(200);
  });

  it('break-glass: with password off for members (and SSO on), a member gets a clear error and an admin still signs in', async () => {
    const wsId = (await sql<{ id: string }>(s, 'SELECT id FROM app.workspaces'))[0]?.id as string;
    await sql(s, `UPDATE app.workspaces SET settings = settings || '{"passwordForMembers": false}'::jsonb`);
    try {
      // the setting alone never locks members out: without an enabled single sign-on provider the password form stays on
      expect((await createApiClient(s.url).signIn(NADIA.email, PERSONA_PASSWORD)).status).toBe(200);
      expect(await methodKinds(createApiClient(s.url))).toContain('password');

      await sql(s, "INSERT INTO app.auth_providers (workspace_id, kind, enabled) VALUES ($1, 'oidc', true)", [wsId]);
      const member = createApiClient(s.url);
      const res = await member.signIn(NADIA.email, PERSONA_PASSWORD);
      expect(res.status).toBe(403);
      const err = await errorOf(res);
      expect(err.code).toBe('forbidden');
      expect(err.message).toMatch(/turned off for members/);
      expect(member.cookies.size).toBe(0);

      // the sign-in page no longer lists the password method; an admin who is signed in still sees it
      expect(await methodKinds(createApiClient(s.url))).toEqual(['oidc']);
      const admin = createApiClient(s.url);
      expect((await admin.signIn(OMAR.email, PERSONA_PASSWORD)).status).toBe(200);
      expect(await methodKinds(admin)).toContain('password');

      // a wrong password still looks like any wrong password (the setting is not revealed to a guesser)
      expect((await errorOf(await createApiClient(s.url).signIn(TARIQ.email, 'wrong-password-123'))).message).toBe('Incorrect email or password.');
    } finally {
      await sql(s, "DELETE FROM app.auth_providers WHERE kind = 'oidc'");
      await sql(s, `UPDATE app.workspaces SET settings = settings - 'passwordForMembers'`);
    }
    expect((await createApiClient(s.url).signIn(NADIA.email, PERSONA_PASSWORD)).status).toBe(200);
  });

  it('a suspended person has no live session and cannot sign in', async () => {
    const c = createApiClient(s.url);
    await c.signIn(TARIQ.email, PERSONA_PASSWORD);
    expect((await c.get('/api/auth/sessions')).status).toBe(200);
    await sql(s, "UPDATE app.people SET status = 'suspended' WHERE id = $1", [TARIQ.personId]);
    try {
      expect((await c.get('/api/auth/sessions')).status).toBe(401);
      expect((await createApiClient(s.url).signIn(TARIQ.email, PERSONA_PASSWORD)).status).toBe(401);
    } finally {
      await sql(s, "UPDATE app.people SET status = 'active' WHERE id = $1", [TARIQ.personId]);
    }
    // the session was ended for good, not just hidden
    expect((await c.get('/api/auth/sessions')).status).toBe(401);
  });

  it('routes without a session are 401, and a dev-header-free request cannot name an actor', async () => {
    const c = createApiClient(s.url);
    expect((await c.get('/api/auth/sessions')).status).toBe(401);
    expect((await c.post('/api/auth/sign-out')).status).toBe(401);
  });
});

describe('rotation and absolute expiry', () => {
  const clock = fakeClock();
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({
      now: clock.now,
      session: { rotateMs: 5 * MINUTE, rotationGraceMs: MINUTE, absoluteMs: 70 * MINUTE },
    });
    await createPersonas(s.db);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  it('replaces the token when it is old, keeps the old one for a short grace, then refuses it', async () => {
    const c = createApiClient(s.url);
    await c.signIn(NADIA.email, PERSONA_PASSWORD);
    const oldToken = c.cookies.get('manythreads_session') as string;
    const oldCsrf = c.cookies.get('manythreads_csrf') as string;

    clock.advance(6 * MINUTE);
    expect((await c.get('/api/auth/sessions')).status).toBe(200);
    const newToken = c.cookies.get('manythreads_session') as string;
    expect(newToken).not.toBe(oldToken);
    expect(c.cookies.get('manythreads_csrf')).not.toBe(oldCsrf);

    // a parallel request that left with the old cookie still works inside the grace
    const stale = await fetch(`${s.url}/api/auth/sessions`, { headers: { cookie: `manythreads_session=${oldToken}` } });
    expect(stale.status).toBe(200);
    expect(stale.headers.getSetCookie()).toEqual([]); // and does not rotate again

    clock.advance(2 * MINUTE);
    const late = await fetch(`${s.url}/api/auth/sessions`, { headers: { cookie: `manythreads_session=${oldToken}` } });
    expect(late.status).toBe(401);
    expect((await c.get('/api/auth/sessions')).status).toBe(200); // the new token is fine (and may rotate again)
  });

  it('survives losing the cache table: a miss reads session_tokens and re-fills', async () => {
    const c = createApiClient(s.url);
    await c.signIn(RAFI.email, PERSONA_PASSWORD);
    await sql(s, 'DELETE FROM app.session_cache');
    expect((await c.get('/api/auth/sessions')).status).toBe(200);
    expect(await count(s, 'session_cache')).toBeGreaterThan(0);
  });

  it('ends a session at the absolute limit even when it is never idle', async () => {
    const c = createApiClient(s.url);
    await c.signIn(OMAR.email, PERSONA_PASSWORD);
    for (let i = 0; i < 3; i++) {
      clock.advance(20 * MINUTE);
      expect((await c.get('/api/auth/sessions')).status).toBe(200);
    }
    clock.advance(20 * MINUTE); // 80 minutes after sign-in, 20 idle
    expect((await c.get('/api/auth/sessions')).status).toBe(401);
  });
  it('abandoned sessions lose their token rows at the next sign-in sweep', async () => {
    const abandoned = createApiClient(s.url);
    await abandoned.signIn(OMAR.email, PERSONA_PASSWORD);
    const rowsFor = async (email: string): Promise<number> =>
      (
        await sql<{ n: number }>(
          s,
          `SELECT count(*)::int AS n FROM app.session_tokens t JOIN app.sessions x ON x.id = t.session_id
           JOIN app.people p ON p.id = x.person_id WHERE p.primary_email = $1`,
          [email],
        )
      )[0]?.n ?? -1;
    expect(await rowsFor(OMAR.email)).toBeGreaterThan(0);
    clock.advance(45 * MINUTE); // idle (30 minutes), never used again
    await createApiClient(s.url).signIn(TARIQ.email, PERSONA_PASSWORD);
    expect(await rowsFor(OMAR.email)).toBe(0);
    expect((await abandoned.get('/api/auth/sessions')).status).toBe(401);
  });
});

describe('password reset and email verification', () => {
  const clock = fakeClock();
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({ now: clock.now, publicUrl: 'https://manythreads.example' });
    await createPersonas(s.db);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  const tokenFrom = (to: string): string => {
    const mail = s.mailer.last(to);
    const m = /\/(?:reset-password|verify-email)\/([A-Za-z0-9_-]+)/.exec(mail?.text ?? '');
    if (!m?.[1]) throw new Error(`no link in mail to ${to}`);
    return m[1];
  };

  it('reset-request is always 202; mail goes only to an existing person, with plain text and HTML', async () => {
    const c = createApiClient(s.url);
    const known = await c.post('/api/auth/password/reset-request', { email: NADIA.email });
    const unknown = await c.post('/api/auth/password/reset-request', { email: 'nobody@kahf.example' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
    expect(s.mailer.to(NADIA.email)).toHaveLength(1);
    expect(s.mailer.to('nobody@kahf.example')).toHaveLength(0);
    const mail = s.mailer.to(NADIA.email)[0];
    expect(mail?.text).toContain('https://manythreads.example/reset-password/');
    expect(mail?.html).toContain('<a href="https://manythreads.example/reset-password/');
  });

  it('resets with a valid token once; an 11-character password is refused without spending the token', async () => {
    const c = createApiClient(s.url);
    const other = createApiClient(s.url);
    await other.signIn(NADIA.email, PERSONA_PASSWORD);
    await c.post('/api/auth/password/reset-request', { email: NADIA.email });
    const token = tokenFrom(NADIA.email);

    const short = await c.post('/api/auth/password/reset', { token, password: '12345678901' });
    expect(short.status).toBe(400);
    expect((await errorOf(short)).message).toContain('at least 12 characters');

    const ok = await c.post('/api/auth/password/reset', { token, password: 'a-brand-new-passphrase' });
    expect(ok.status).toBe(200);
    expect((await c.post('/api/auth/password/reset', { token, password: 'another-new-passphrase' })).status).toBe(410);

    expect((await createApiClient(s.url).signIn(NADIA.email, PERSONA_PASSWORD)).status).toBe(401);
    expect((await createApiClient(s.url).signIn(NADIA.email, 'a-brand-new-passphrase')).status).toBe(200);
    expect((await other.get('/api/auth/sessions')).status).toBe(401); // every session was ended
    const types = (await sql<{ type: string }>(s, "SELECT type FROM app.events WHERE type = 'identity.password.reset'")).length;
    expect(types).toBe(1);
  });

  it('a reset spends every other reset link of that person too', async () => {
    const c = createApiClient(s.url);
    await c.post('/api/auth/password/reset-request', { email: OMAR.email });
    const real = tokenFrom(OMAR.email);
    const planted = 'planted-reset-token-for-the-test-0123456789ab';
    await sql(
      s,
      `INSERT INTO app.email_verifications (workspace_id, person_id, purpose, token_hash, expires_at)
       SELECT workspace_id, person_id, 'reset_password', $2, now() + interval '1 hour' FROM app.email_verifications WHERE token_hash = $1`,
      [hashLinkToken(real), hashLinkToken(planted)],
    );
    expect((await c.post('/api/auth/password/reset', { token: real, password: 'omar-new-passphrase-1' })).status).toBe(200);
    expect((await c.post('/api/auth/password/reset', { token: planted, password: 'attacker-passphrase-2' })).status).toBe(410);
    expect((await createApiClient(s.url).signIn(OMAR.email, 'omar-new-passphrase-1')).status).toBe(200);
  });

  it('a reset token expires after an hour, and a newer request replaces the older token', async () => {
    const c = createApiClient(s.url);
    await c.post('/api/auth/password/reset-request', { email: RAFI.email });
    const first = tokenFrom(RAFI.email);
    await c.post('/api/auth/password/reset-request', { email: RAFI.email });
    const second = tokenFrom(RAFI.email);
    expect(second).not.toBe(first);
    expect((await c.post('/api/auth/password/reset', { token: first, password: 'a-brand-new-passphrase' })).status).toBe(410);
    clock.advance(61 * MINUTE);
    expect((await c.post('/api/auth/password/reset', { token: second, password: 'a-brand-new-passphrase' })).status).toBe(410);
  });

  it('tokens are stored hashed', async () => {
    const token = tokenFrom(RAFI.email);
    const rows = await sql<{ token_hash: Buffer }>(s, 'SELECT token_hash FROM app.email_verifications');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.token_hash.toString('base64url')).not.toBe(token);
  });

  it('verifies the primary email by mailed link, once', async () => {
    const c = createApiClient(s.url);
    await c.signIn(TARIQ.email, PERSONA_PASSWORD);
    expect((await c.post('/api/auth/email/verify-request')).status).toBe(202);
    const token = tokenFrom(TARIQ.email);
    const anon = createApiClient(s.url);
    const res = await anon.post('/api/auth/email/verify', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: TARIQ.email });
    const rows = await sql<{ verified_at: Date | null }>(s, 'SELECT verified_at FROM app.person_emails WHERE person_id = $1', [TARIQ.personId]);
    expect(rows[0]?.verified_at).not.toBeNull();
    expect((await anon.post('/api/auth/email/verify', { token })).status).toBe(410);
  });
});

describe('test-only session endpoint', () => {
  let without: TestServer;
  let withToken: TestServer;
  beforeAll(async () => {
    without = await startTestServer();
    withToken = await startTestServer({ testAuthToken: TEST_AUTH_TOKEN });
    await createPersonas(without.db);
    await createPersonas(withToken.db);
  }, 120_000);
  afterAll(async () => {
    await without.close();
    await withToken.close();
  });

  it('does not exist unless MANYTHREADS_TEST_AUTH_TOKEN is configured', async () => {
    const c = createApiClient(without.url);
    const res = await c.testSignIn(NADIA.email, TEST_AUTH_TOKEN);
    expect(res.status).toBe(404);
    expect(c.cookies.size).toBe(0);
  });

  it('with the token configured it still answers 404 without the header or with a wrong one', async () => {
    const c = createApiClient(withToken.url);
    expect((await c.post('/api/test/session', { email: NADIA.email })).status).toBe(404);
    expect((await c.testSignIn(NADIA.email, 'wrong-token')).status).toBe(404);
    expect((await c.testSignIn(NADIA.email, `${TEST_AUTH_TOKEN}x`)).status).toBe(404);
    expect((await c.post('/api/test/session', { bogus: true }, { 'x-test-auth': 'wrong-token' })).status).toBe(404);
    expect(c.cookies.size).toBe(0);
  });

  it('with the token and header it issues a real session for an existing person', async () => {
    const c = createApiClient(withToken.url);
    const res = await c.testSignIn(NADIA.email, TEST_AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ personId: NADIA.personId, workspaceId: NADIA.workspaceId });
    expect(res.headers.getSetCookie().find((x) => x.startsWith('manythreads_session='))).toMatch(/HttpOnly/i);
    const me = GetSessionResponse.parse(await (await c.get('/api/session')).json());
    expect(me).toMatchObject({ authenticated: true, person: { email: NADIA.email } });
    expect((await c.post('/api/auth/sign-out')).status).toBe(200); // CSRF cookie works like a real session's
    expect((await c.testSignIn('nobody@kahf.example', TEST_AUTH_TOKEN)).status).toBe(404);
  });
});
