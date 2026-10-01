import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { personas, TEAM_IDS, type Persona } from '@manythreads/test-utils';

/**
 * Row level security through the HTTP API (PLAN criterion 6, spec e2e/api/identity/rls.spec.ts): Sameera, a member of
 * Customer support only, reaches nothing of Engineering, whichever route she tries; every answer is 403, 404 or empty.
 * Callers are the seeded personas through the test-only dev header (NODE_ENV=test).
 */

const { omar, sameera, lena, nadia, priya } = personas;

const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

async function engineeringStub(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/test/stub-resources', {
    headers: as(omar),
    data: { teamId: TEAM_IDS.Engineering, name: `eng-${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.describe('Sameera cannot cross into Engineering', () => {
  test('her team list holds only Customer support', async ({ request }) => {
    const res = await request.get('/api/teams', { headers: as(sameera) });
    expect(res.status()).toBe(200);
    const { teams } = (await res.json()) as { teams: { slug: string }[] };
    expect(teams.map((t) => t.slug)).toEqual(['customer-support']);
  });

  test('the team, its roster, tags and invitations are 403', async ({ request }) => {
    for (const path of ['', '/roster', '/tags', '/invitations']) {
      const res = await request.get(`/api/teams/engineering${path}`, { headers: as(sameera) });
      expect(res.status(), `GET /api/teams/engineering${path}`).toBe(403);
    }
  });

  test('a stub resource of Engineering is 403, an unknown one is 403 too, her own team is readable', async ({ request }) => {
    const id = await engineeringStub(request);
    expect((await request.get(`/api/test/stub-resources/${id}`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/test/stub-resources/${randomUUID()}`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/test/stub-resources/${id}`, { headers: as(nadia) })).status()).toBe(200);

    const own = await request.post('/api/test/stub-resources', {
      headers: as(omar),
      data: { teamId: TEAM_IDS['Customer support'], name: `support-${randomUUID()}` },
    });
    const ownId = ((await own.json()) as { id: string }).id;
    expect((await request.get(`/api/test/stub-resources/${ownId}`, { headers: as(sameera) })).status()).toBe(200);
    expect((await request.get(`/api/test/stub-resources/${ownId}`, { headers: as(nadia) })).status()).toBe(403);
  });

  test('she cannot write into Engineering: no stub resource, member, role, tag or invitation', async ({ request }) => {
    const headers = as(sameera);
    expect(
      (await request.post('/api/test/stub-resources', { headers, data: { teamId: TEAM_IDS.Engineering, name: 'x' } })).status(),
    ).toBe(403);
    expect((await request.post('/api/teams/engineering/members', { headers, data: { personId: sameera.personId } })).status()).toBe(403);
    expect(
      (await request.patch(`/api/teams/engineering/members/${nadia.personId}`, { headers, data: { role: 'lead' } })).status(),
    ).toBe(403);
    expect(
      (await request.put(`/api/teams/engineering/members/${nadia.personId}/tags/role:on-call`, { headers })).status(),
    ).toBe(403);
    expect((await request.post('/api/teams/engineering/invitations', { headers, data: { email: 'x@kahf.example' } })).status()).toBe(403);
    expect((await request.patch('/api/teams/engineering', { headers, data: { name: 'Mine' } })).status()).toBe(403);
    expect((await request.post('/api/teams/engineering/archive', { headers })).status()).toBe(403);
  });

  test('workspace settings do not exist for her (404), and she cannot create teams or workspace invitations', async ({ request }) => {
    const headers = as(sameera);
    expect((await request.get('/api/workspace/members', { headers })).status()).toBe(404);
    expect((await request.post('/api/teams', { headers, data: { name: 'Sameera team' } })).status()).toBe(403);
    expect((await request.post('/api/invitations', { headers, data: { email: 'y@kahf.example', role: 'member' } })).status()).toBe(403);
  });

  test('roster changes in her own team are for leads and admins, not members', async ({ request }) => {
    const res = await request.post(`/api/teams/customer-support/members`, {
      headers: as(sameera),
      data: { personId: priya.personId },
    });
    // Sameera is a member, not a lead: roster changes are for leads and admins.
    expect(res.status()).toBe(403);
  });
});

test.describe('Lena (guest) and Omar (owner)', () => {
  test('Lena has no teams and gets 403 on every team route', async ({ request }) => {
    const headers = as(lena);
    const list = (await (await request.get('/api/teams', { headers })).json()) as { teams: unknown[] };
    expect(list.teams).toEqual([]);
    expect((await request.get('/api/teams/engineering', { headers })).status()).toBe(403);
    expect((await request.get('/api/teams/engineering/roster', { headers })).status()).toBe(403);
    expect((await request.get('/api/workspace/members', { headers })).status()).toBe(404);
  });

  test('Omar sees every team and the workspace members with their roles', async ({ request }) => {
    const headers = as(omar);
    const list = (await (await request.get('/api/teams', { headers })).json()) as { teams: { slug: string }[] };
    expect(list.teams.map((t) => t.slug)).toEqual(expect.arrayContaining(['engineering', 'customer-support', 'marketing']));
    const members = (await (await request.get('/api/workspace/members', { headers })).json()) as {
      members: { displayName: string; role: string }[];
    };
    expect(members.members.find((m) => m.displayName === 'Lena')?.role).toBe('guest');
    expect(members.members.find((m) => m.displayName === 'Omar')?.role).toBe('owner');
  });
});
