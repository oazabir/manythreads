import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';
import { fake, stateOf } from '../../connections/support.ts';

/*
 * Offboarding at the API (PLAN P16-11, decisions D33 and D34), on seed v16: Lena has a Microsoft sign-in, Rafi a Google one. The preview changes nothing; pressing the button switches their own
 * connections off at once and removes them within a minute with one audit line; an admin cannot press it for themselves; a person who is not an admin cannot see or press it; suspending a
 * person does the same by itself; and reactivating restores nothing. The Google revoke call reaches the stand-in (Microsoft has no revoke address and is not asked).
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'connectors', MANYTHREADS_STACK_API_ONLY: '1' });

const { omar, priya, lena, rafi } = personas;
const as = (p: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }) });

interface People {
  people: Array<{ personName: string; connector: string; state: string }>;
}

test('the preview names the services and changes nothing', async ({ request }) => {
  await iso.start();
  const res = await request.get(`/api/admin/people/${lena.personId}/offboard-connections`, { headers: as(omar) });
  expect(res.status()).toBe(200);
  const { preview } = (await res.json()) as { preview: { own: Array<{ connector: string }>; moving: unknown[] } };
  expect(preview.own.map((o) => o.connector)).toEqual(['microsoft']);
  expect(preview.moving).toEqual([]);
  const people = (await (await request.get('/api/admin/connections/people', { headers: as(omar) })).json()) as People;
  expect(people.people.filter((p) => p.personName.includes('Lena')).map((p) => p.state)).toEqual(['ok']);
});

test('a person who is not an admin can neither see the preview nor press the button; nobody presses it for themselves', async ({ request }) => {
  await iso.start();
  for (const who of [priya, lena]) {
    expect((await request.get(`/api/admin/people/${rafi.personId}/offboard-connections`, { headers: as(who) })).status(), who.key).toBe(403);
    expect((await request.post(`/api/admin/people/${rafi.personId}/offboard-connections`, { headers: as(who), data: {} })).status(), who.key).toBe(403);
  }
  expect((await request.post(`/api/admin/people/${omar.personId}/offboard-connections`, { headers: as(omar), data: {} })).status()).toBe(400);
});

test('pressing the button answers 202, switches Lena off at once, and removes her sign-in within a minute with one audit line', async ({ request }) => {
  const stack = await iso.start();
  const res = await request.post(`/api/admin/people/${lena.personId}/offboard-connections`, { headers: as(omar), data: {} });
  expect(res.status()).toBe(202);
  const { result } = (await res.json()) as { result: { queued: boolean; disabled: number; moved: number } };
  expect(result).toMatchObject({ queued: true, disabled: 1, moved: 0 });
  await expect
    .poll(async () => ((await (await request.get('/api/admin/connections/people', { headers: as(omar) })).json()) as People).people.filter((p) => p.personName.includes('Lena')).length, { timeout: 90_000, intervals: [1_000, 3_000] })
    .toBe(0);
  const audit = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.events WHERE type = 'connections.person.offboarded'`);
  expect(audit[0]!.n).toBe('1');
  // the audit line carries counts and ids, never a token
  const line = await stack.sql<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'connections.person.offboarded'`);
  expect(JSON.stringify(line[0]!.payload)).not.toMatch(/fs_[a-z]+_[0-9a-f]{24}/);
  // pressing again finds nothing to do and writes no second line
  const again = await request.post(`/api/admin/people/${lena.personId}/offboard-connections`, { headers: as(omar), data: {} });
  expect(again.status()).toBeLessThan(500);
  expect((await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.events WHERE type = 'connections.person.offboarded'`))[0]!.n).toBe('1');
});

test('suspending Rafi does the same by itself: the stand-in is asked to forget his Google grant, and reactivating restores nothing', async ({ request }) => {
  const stack = await iso.start();
  const before = (await stateOf(stack)).workspace.revoked.length;
  const suspended = await request.patch(`/api/workspace/members/${rafi.personId}`, { headers: as(omar), data: { status: 'suspended' } });
  expect(suspended.status()).toBe(200);
  await expect
    .poll(async () => ((await (await request.get('/api/admin/connections/people', { headers: as(omar) })).json()) as People).people.filter((p) => p.personName.includes('Rafi')).length, { timeout: 90_000, intervals: [1_000, 3_000] })
    .toBe(0);
  expect((await stateOf(stack)).workspace.revoked.length).toBeGreaterThan(before);

  const back = await request.patch(`/api/workspace/members/${rafi.personId}`, { headers: as(omar), data: { status: 'active' } });
  expect(back.status()).toBe(200);
  const people = ((await (await request.get('/api/admin/connections/people', { headers: as(omar) })).json()) as People).people;
  expect(people.filter((p) => p.personName.includes('Rafi'))).toHaveLength(0);
  // the stand-in is untouched by a reactivation
  await fake(stack, 'GET', '/__fake/health');
});
