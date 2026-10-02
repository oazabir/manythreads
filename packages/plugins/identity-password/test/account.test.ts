import { withSystem } from '@manythreads/kernel';
import { ErrorEnvelope, GetSessionResponse, ListSessionsResponse } from '@manythreads/shared';
import {
  createApiClient,
  createPersonas,
  startTestServer,
  LENA,
  NADIA,
  OMAR,
  PERSONA_PASSWORD,
  PRIYA,
  RAFI,
  SAMEERA,
  TARIQ,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const NEW_PASSWORD = 'a-brand-new-passphrase';
const errorOf = async (res: Response) => ErrorEnvelope.parse(await res.json()).error;

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer({ publicUrl: 'https://manythreads.example' });
  await createPersonas(s.db);
}, 120_000);
afterAll(async () => {
  await s.close();
});

async function sql<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return withSystem(async (tx) => (await tx.query(text, values)).rows as T[], { pool: s.pools.system });
}
const liveSessions = async (c: ReturnType<typeof createApiClient>) => (await c.get('/api/auth/sessions')).status;

describe('POST /api/auth/password/change', () => {
  it('needs a session', async () => {
    const res = await createApiClient(s.url).post('/api/auth/password/change', { currentPassword: PERSONA_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuses a wrong current password with a message the form can show, and changes nothing', async () => {
    const c = createApiClient(s.url);
    await c.signIn(RAFI.email, PERSONA_PASSWORD);
    const events = (await sql<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'identity.password.changed'"))[0]?.n;
    const res = await c.post('/api/auth/password/change', { currentPassword: 'not-my-password-123', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400); // never 401: the web client would read that as an expired session
    expect(await errorOf(res)).toMatchObject({ code: 'validation_failed', message: 'Your current password is incorrect.' });
    expect(await liveSessions(c)).toBe(200);
    expect((await createApiClient(s.url).signIn(RAFI.email, PERSONA_PASSWORD)).status).toBe(200);
    expect((await createApiClient(s.url).signIn(RAFI.email, NEW_PASSWORD)).status).toBe(401);
    expect((await sql<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'identity.password.changed'"))[0]?.n).toBe(events);
  });

  it('refuses an 11-character new password with the rule, a missing field, an unknown field and an unchanged password', async () => {
    const c = createApiClient(s.url);
    await c.signIn(SAMEERA.email, PERSONA_PASSWORD);
    const short = await c.post('/api/auth/password/change', { currentPassword: PERSONA_PASSWORD, newPassword: '12345678901' });
    expect(short.status).toBe(400);
    const err = await errorOf(short);
    expect(err.message).toContain('at least 12 characters');
    expect(err.path).toEqual(['newPassword']);
    expect((await c.post('/api/auth/password/change', { newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await c.post('/api/auth/password/change', { currentPassword: PERSONA_PASSWORD, newPassword: NEW_PASSWORD, email: 'x@y.z' })).status).toBe(400);
    const same = await c.post('/api/auth/password/change', { currentPassword: PERSONA_PASSWORD, newPassword: PERSONA_PASSWORD });
    expect(same.status).toBe(400);
    expect((await createApiClient(s.url).signIn(SAMEERA.email, PERSONA_PASSWORD)).status).toBe(200);
  });

  it('changes the password, keeps this session, ends every other one, spends reset links, and audits it', async () => {
    const here = createApiClient(s.url);
    const phone = createApiClient(s.url);
    const laptop = createApiClient(s.url);
    const omar = createApiClient(s.url);
    await here.signIn(NADIA.email, PERSONA_PASSWORD);
    await phone.signIn(NADIA.email, PERSONA_PASSWORD);
    await laptop.signIn(NADIA.email, PERSONA_PASSWORD);
    await omar.signIn(OMAR.email, PERSONA_PASSWORD);

    // A reset link mailed earlier would undo the change, so it must stop working.
    await createApiClient(s.url).post('/api/auth/password/reset-request', { email: NADIA.email });
    const link = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(s.mailer.last(NADIA.email)?.text ?? '')?.[1] as string;
    expect(link).toBeDefined();

    const res = await here.post('/api/auth/password/change', { currentPassword: PERSONA_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revokedSessions: 2 });

    expect(await liveSessions(here)).toBe(200);
    const list = ListSessionsResponse.parse(await (await here.get('/api/auth/sessions')).json());
    expect(list.sessions.filter((x) => x.current)).toHaveLength(1);
    expect(await liveSessions(phone)).toBe(401);
    expect(await liveSessions(laptop)).toBe(401);
    expect(await liveSessions(omar)).toBe(200); // someone else's sessions are untouched

    expect((await createApiClient(s.url).signIn(NADIA.email, PERSONA_PASSWORD)).status).toBe(401);
    expect((await createApiClient(s.url).signIn(NADIA.email, NEW_PASSWORD)).status).toBe(200);
    expect((await createApiClient(s.url).post('/api/auth/password/reset', { token: link, password: 'attacker-chosen-passphrase' })).status).toBe(410);
    expect((await createApiClient(s.url).signIn(NADIA.email, 'attacker-chosen-passphrase')).status).toBe(401);

    const events = await sql<{ payload: Record<string, unknown>; workspace_id: string }>(
      "SELECT payload, workspace_id FROM app.events WHERE type = 'identity.password.changed'",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.workspace_id).toBe(NADIA.workspaceId);
    expect(events[0]?.payload).toMatchObject({ personId: NADIA.personId, revokedSessions: 2 });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(NEW_PASSWORD);

    const stored = await sql<{ hash: string }>('SELECT hash FROM app.password_credentials WHERE person_id = $1', [NADIA.personId]);
    expect(stored[0]?.hash).toMatch(/^\$argon2id\$/);
    expect(stored[0]?.hash).not.toContain(NEW_PASSWORD);
  });

  it('a person without a password (single sign-on only) is told to use the reset link', async () => {
    const c = createApiClient(s.url);
    await c.signIn(PRIYA.email, PERSONA_PASSWORD);
    await sql('DELETE FROM app.password_credentials WHERE person_id = $1', [PRIYA.personId]);
    const res = await c.post('/api/auth/password/change', { currentPassword: PERSONA_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain('no password');
  });

  it('cuts off guessing of the current password from a signed-in session', async () => {
    const c = createApiClient(s.url);
    await c.signIn(TARIQ.email, PERSONA_PASSWORD);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await c.post('/api/auth/password/change', { currentPassword: `wrong-guess-${i}-xyz`, newPassword: NEW_PASSWORD })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('PATCH /api/account', () => {
  it('needs a session', async () => {
    expect((await createApiClient(s.url).request('PATCH', '/api/account', { body: { displayName: 'Nobody' } })).status).toBe(401);
  });

  it('renames the caller (trimmed), and the session shows the new name', async () => {
    const c = createApiClient(s.url);
    await c.signIn(RAFI.email, PERSONA_PASSWORD);
    const res = await c.request('PATCH', '/api/account', { body: { displayName: '  Rafi Khan  ' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person: { id: RAFI.personId, name: 'Rafi Khan', email: RAFI.email } });
    const me = GetSessionResponse.parse(await (await c.get('/api/session')).json());
    expect(me.authenticated && me.person.name).toBe('Rafi Khan');
  });

  it('works for every kind of member, a guest included', async () => {
    const c = createApiClient(s.url);
    await c.signIn(LENA.email, PERSONA_PASSWORD);
    expect((await c.request('PATCH', '/api/account', { body: { displayName: 'Lena M.' } })).status).toBe(200);
  });

  it('only ever touches the caller: there is no id, and email, role and status are not editable', async () => {
    const c = createApiClient(s.url);
    await c.signIn(SAMEERA.email, PERSONA_PASSWORD);
    for (const extra of [{ id: OMAR.personId }, { email: 'owner@evil.example' }, { role: 'owner' }, { status: 'suspended' }]) {
      const res = await c.request('PATCH', '/api/account', { body: { displayName: 'Hijack', ...extra } });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const rows = await sql<{ id: string; display_name: string; primary_email: string }>(
      'SELECT id, display_name, primary_email FROM app.people WHERE id = ANY($1)',
      [[OMAR.personId, SAMEERA.personId]],
    );
    expect(rows.find((r) => r.id === OMAR.personId)?.display_name).toBe('Omar');
    expect(rows.find((r) => r.id === SAMEERA.personId)).toMatchObject({ display_name: 'Sameera', primary_email: SAMEERA.email });
  });

  it('refuses an empty or over-long name', async () => {
    const c = createApiClient(s.url);
    await c.signIn(SAMEERA.email, PERSONA_PASSWORD);
    for (const displayName of ['', '   ', 'x'.repeat(121)]) {
      const res = await c.request('PATCH', '/api/account', { body: { displayName } });
      expect(res.status, displayName).toBe(400);
      expect((await errorOf(res)).code).toBe('validation_failed');
    }
    expect((await sql<{ display_name: string }>('SELECT display_name FROM app.people WHERE id = $1', [SAMEERA.personId]))[0]?.display_name).toBe('Sameera');
  });
});
