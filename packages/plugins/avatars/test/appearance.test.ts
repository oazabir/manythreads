import { withSystem } from '@manythreads/kernel';
import { GetSessionResponse, MyAppearanceResponse } from '@manythreads/shared';
import { LENA, NADIA, OMAR, PERSONA_PASSWORD, createApiClient, createPersonas, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P21-21: PUT /api/me/appearance and the choice served in GET /api/session. The test signs in for real (cookie and CSRF), because a dev-header caller has no session.

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await createPersonas(s.db);
}, 120_000);
afterAll(async () => {
  await s?.close();
});

const signedIn = async (email: string) => {
  const c = createApiClient(s.url);
  expect((await c.signIn(email, PERSONA_PASSWORD)).status).toBe(200);
  return c;
};
const put = (c: ReturnType<typeof createApiClient>, body: unknown) => c.request('PUT', '/api/me/appearance', { body });
const sessionOf = async (c: ReturnType<typeof createApiClient>) => {
  const me = GetSessionResponse.parse(await (await c.get('/api/session')).json());
  if (!me.authenticated) throw new Error('not signed in');
  return me.person.appearance;
};
const stored = async (personId: string) =>
  withSystem(async (tx) => (await tx.query<{ theme: string; density: string; palette: string }>('SELECT theme, density, palette FROM app.people WHERE id = $1', [personId])).rows[0], { pool: s.pools.system });

describe('PUT /api/me/appearance', () => {
  it('starts as System and Comfortable, and the session says so', async () => {
    const c = await signedIn(OMAR.email);
    expect(await sessionOf(c)).toEqual({ theme: 'system', density: 'comfortable', palette: 'classic' });
  });

  it('saves a theme and a density, answers what is stored, and the session carries them', async () => {
    const c = await signedIn(NADIA.email);
    const res = await put(c, { theme: 'dark', density: 'compact' });
    expect(res.status).toBe(200);
    expect(MyAppearanceResponse.parse(await res.json())).toEqual({ theme: 'dark', density: 'compact', palette: 'classic' });
    expect(await sessionOf(c)).toEqual({ theme: 'dark', density: 'compact', palette: 'classic' });
    expect(await stored(NADIA.personId)).toEqual({ theme: 'dark', density: 'compact', palette: 'classic' });
    // a new sign-in on another device sees the same
    expect(await sessionOf(await signedIn(NADIA.email))).toEqual({ theme: 'dark', density: 'compact', palette: 'classic' });
  });

  it('keeps the field that is left out', async () => {
    const c = await signedIn(NADIA.email);
    expect(MyAppearanceResponse.parse(await (await put(c, { theme: 'light' })).json())).toEqual({ theme: 'light', density: 'compact', palette: 'classic' });
    expect(MyAppearanceResponse.parse(await (await put(c, { density: 'comfortable' })).json())).toEqual({ theme: 'light', density: 'comfortable', palette: 'classic' });
  });

  it('saves a palette (theme look) on its own, keeps the other fields, and the session carries it', async () => {
    const c = await signedIn(OMAR.email);
    const res = await put(c, { palette: 'linen' });
    expect(res.status).toBe(200);
    expect(MyAppearanceResponse.parse(await res.json())).toEqual({ theme: 'system', density: 'comfortable', palette: 'linen' });
    expect(await sessionOf(c)).toEqual({ theme: 'system', density: 'comfortable', palette: 'linen' });
    expect(await stored(OMAR.personId)).toEqual({ theme: 'system', density: 'comfortable', palette: 'linen' });
    expect(MyAppearanceResponse.parse(await (await put(c, { theme: 'dark', palette: 'harbor' })).json())).toEqual({ theme: 'dark', density: 'comfortable', palette: 'harbor' });
    expect(MyAppearanceResponse.parse(await (await put(c, { palette: 'graphite' })).json())).toEqual({ theme: 'dark', density: 'comfortable', palette: 'graphite' });
    expect(MyAppearanceResponse.parse(await (await put(c, { palette: 'classic', theme: 'system' })).json())).toEqual({ theme: 'system', density: 'comfortable', palette: 'classic' });
  });

  it('changes only the caller: another person keeps their own', async () => {
    const before = await stored(OMAR.personId);
    await put(await signedIn(NADIA.email), { theme: 'dark' });
    expect(await stored(OMAR.personId)).toEqual(before);
  });

  it('refuses an unknown value, an unknown field and an empty body (400), and changes nothing', async () => {
    const c = await signedIn(NADIA.email);
    const before = await stored(NADIA.personId);
    for (const body of [{ theme: 'neon' }, { density: 'huge' }, { palette: 'neon' }, { palette: null }, { palette: '__proto__' }, { theme: 'dark', colour: 'red' }, {}, { theme: null }]) {
      expect((await put(c, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await stored(NADIA.personId)).toEqual(before);
  });

  it('needs a session', async () => {
    expect((await put(createApiClient(s.url), { theme: 'dark' })).status).toBe(401);
  });

  it('is open to a guest, for the guest own row only', async () => {
    const c = await signedIn(LENA.email);
    const res = await put(c, { theme: 'dark' });
    expect(res.status).toBe(200);
    expect(await sessionOf(c)).toEqual({ theme: 'dark', density: 'comfortable', palette: 'classic' });
  });

  it('a signed-out session still parses for a client that expects no appearance (older server answer)', () => {
    const parsed = GetSessionResponse.parse({
      authenticated: true,
      person: { id: OMAR.personId, name: 'Omar', email: OMAR.email },
      workspace: { id: OMAR.workspaceId, name: 'Kahf' },
      role: 'owner',
      teams: [],
      methods: [],
      expiresAt: '2026-11-08T00:00:00.000Z',
    });
    expect(parsed.authenticated && parsed.person.appearance).toEqual({ theme: 'system', density: 'comfortable', palette: 'classic' });
  });
});
