import { ListWorkspaceMembersResponse, UpdateWorkspaceMemberResponse, parseEvent } from '@manythreads/shared';
import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

// P20-13: an admin deactivates and reactivates a member through PATCH /api/workspace/members/:personId { status }.

const { omar, nadia, priya, tariq, lena } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: { status: number; body: unknown }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const events = (type: string): Promise<EventRow[]> =>
  w.system(
    async (tx) =>
      (
        await tx.query<EventRow>(
          'SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = $1 ORDER BY id',
          [type],
        )
      ).rows,
  );

describe('deactivating a member (P20-13)', () => {
  const patch = (who: typeof omar | typeof nadia, personId: string, body: Record<string, unknown>) => w.call(who, 'PATCH', `/api/workspace/members/${personId}`, body);

  it('a member and a guest get 404; an admin deactivates a member, which stamps suspended_at and emits one event', async () => {
    expect((await patch(nadia, tariq.personId, { status: 'suspended' })).status).toBe(404);
    expect((await patch(lena, tariq.personId, { status: 'suspended' })).status).toBe(404);
    const before = await events('workspace.member.status_changed');
    const done = UpdateWorkspaceMemberResponse.parse(ok(await patch(omar, nadia.personId, { status: 'suspended' })));
    expect(done).toMatchObject({ personId: nadia.personId, status: 'suspended' });
    const { members } = ListWorkspaceMembersResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/members')));
    const row = members.find((m) => m.personId === nadia.personId);
    expect(row).toMatchObject({ status: 'suspended' });
    expect(row?.suspendedAt).toEqual(expect.any(String));
    expect(members.find((m) => m.personId === priya.personId)?.suspendedAt).toBeNull();
    const after = await events('workspace.member.status_changed');
    expect(after).toHaveLength(before.length + 1);
    const payload = parseEvent(eventToRaw(after.at(-1)!));
    expect(payload).toMatchObject({ personId: nadia.personId, previousStatus: 'active', status: 'suspended', changedBy: omar.personId });
  });

  it('the same status again changes nothing and emits nothing; reactivating clears suspended_at', async () => {
    const count = (await events('workspace.member.status_changed')).length;
    expect(UpdateWorkspaceMemberResponse.parse(ok(await patch(omar, nadia.personId, { status: 'suspended' }))).status).toBe('suspended');
    expect(await events('workspace.member.status_changed')).toHaveLength(count);
    expect(UpdateWorkspaceMemberResponse.parse(ok(await patch(omar, nadia.personId, { status: 'active' }))).status).toBe('active');
    const { members } = ListWorkspaceMembersResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/members')));
    expect(members.find((m) => m.personId === nadia.personId)).toMatchObject({ status: 'active', suspendedAt: null });
  });

  it('a deactivated person\'s requests end: the session is signed out on the next call', async () => {
    ok(await patch(omar, nadia.personId, { status: 'suspended' }));
    const res = await w.call(nadia, 'GET', '/api/workspace');
    expect([401, 403, 404]).toContain(res.status);
    ok(await patch(omar, nadia.personId, { status: 'active' }));
  });

  it('refuses your own account (400), an unknown person (404) and an empty body (400)', async () => {
    expect((await patch(omar, omar.personId, { status: 'suspended' })).status).toBe(400);
    expect((await patch(omar, '00000000-0000-7000-8000-00000000ffff', { status: 'suspended' })).status).toBe(404);
    expect((await patch(omar, nadia.personId, {})).status).toBe(400);
  });

  it('a plain admin cannot deactivate an owner (403); the owner who can is blocked from dropping the last active one', async () => {
    ok(await patch(omar, priya.personId, { role: 'admin' }));
    expect((await patch(priya, omar.personId, { status: 'suspended' })).status).toBe(403);
    expect((await patch(priya, omar.personId, { status: 'suspended' })).status).toBe(403);
    ok(await patch(omar, tariq.personId, { role: 'owner' }));
    ok(await patch(omar, tariq.personId, { status: 'suspended' }));
    ok(await patch(omar, tariq.personId, { status: 'active' }));
  });

  it('two owners deactivating each other at the same moment leave one active owner', async () => {
    await w.system(async (tx) => {
      await tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [tariq.personId]);
      await tx.query("UPDATE app.workspace_members SET role = 'owner' WHERE person_id = ANY ($1::uuid[])", [[omar.personId, tariq.personId]]);
    });
    const results = await Promise.allSettled([patch(omar, tariq.personId, { status: 'suspended' }), patch(tariq, omar.personId, { status: 'suspended' })]);
    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0)).sort();
    // The loser either finds the workspace has no other active owner (409) or is already deactivated and so no longer an admin (404).
    expect(statuses[0]).toBe(200);
    expect([404, 409]).toContain(statuses[1]);
    const active = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.workspace_members wm JOIN app.people p ON p.id = wm.person_id WHERE wm.role = 'owner' AND p.status = 'active'")).rows[0]?.n);
    expect(active).toBe(1);
  });
});
