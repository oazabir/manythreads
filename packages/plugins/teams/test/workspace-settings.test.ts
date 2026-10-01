import {
  GetWorkspaceResponse,
  ListWorkspaceMembersResponse,
  UpdateWorkspaceMemberResponse,
  parseEvent,
} from '@manythreads/shared';
import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

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
const errorOf = (res: { body: unknown }): { code: string; message: string } => (res.body as { error: { code: string; message: string } }).error;

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

describe('workspace General settings', () => {
  it('an owner reads the settings; the defaults are self-signup off and the password form on for members', async () => {
    const { workspace } = GetWorkspaceResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace')));
    expect(workspace).toMatchObject({ name: 'Kahf Software', selfSignup: false, passwordForMembers: true });
  });

  it('is 404 for a member and a guest (the page does not exist for them) and 401 without an actor', async () => {
    for (const who of [nadia, lena]) {
      expect((await w.call(who, 'GET', '/api/workspace')).status).toBe(404);
      expect((await w.call(who, 'PATCH', '/api/workspace', { name: 'Hacked' })).status).toBe(404);
    }
    expect((await w.call(null, 'GET', '/api/workspace')).status).toBe(401);
    expect((await w.call(null, 'PATCH', '/api/workspace', { name: 'Hacked' })).status).toBe(401);
    const { workspace } = GetWorkspaceResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace')));
    expect(workspace.name).toBe('Kahf Software');
  });

  it('refuses an empty change, an empty name, an unknown field and a wrong type', async () => {
    for (const body of [{}, { name: '   ' }, { name: 'x'.repeat(81) }, { colour: 'red' }, { selfSignup: 'yes' }]) {
      const res = await w.call(omar, 'PATCH', '/api/workspace', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe('validation_failed');
    }
  });

  it('changes the name, self-signup and the member password form; each change is audited with its new value', async () => {
    const before = (await events('workspace.settings.updated')).length;
    const res = await w.call(omar, 'PATCH', '/api/workspace', { name: '  Kahf Group ', selfSignup: true, passwordForMembers: false });
    const { workspace } = GetWorkspaceResponse.parse(ok(res));
    expect(workspace).toMatchObject({ name: 'Kahf Group', selfSignup: true, passwordForMembers: false });

    await w.system(async (tx) => {
      const row = (await tx.query<{ name: string; self_signup: boolean; settings: Record<string, unknown> }>('SELECT name, self_signup, settings FROM app.workspaces')).rows[0];
      expect(row).toMatchObject({ name: 'Kahf Group', self_signup: true, settings: { passwordForMembers: false } });
    });

    const all = await events('workspace.settings.updated');
    expect(all).toHaveLength(before + 1);
    const last = all[all.length - 1] as EventRow;
    expect(() => parseEvent(eventToRaw(last))).not.toThrow();
    expect(last.payload).toMatchObject({ personId: omar.personId, changes: { name: 'Kahf Group', selfSignup: true, passwordForMembers: false } });
  });

  it('a partial change touches only that field, and a no-op change emits nothing', async () => {
    const before = (await events('workspace.settings.updated')).length;
    const { workspace } = GetWorkspaceResponse.parse(ok(await w.call(omar, 'PATCH', '/api/workspace', { passwordForMembers: true })));
    expect(workspace).toMatchObject({ name: 'Kahf Group', selfSignup: true, passwordForMembers: true });
    const all = await events('workspace.settings.updated');
    expect(all).toHaveLength(before + 1);
    expect((all[all.length - 1] as EventRow).payload).toMatchObject({ changes: { passwordForMembers: true } });
    expect(Object.keys(((all[all.length - 1] as EventRow).payload as { changes: object }).changes)).toEqual(['passwordForMembers']);

    ok(await w.call(omar, 'PATCH', '/api/workspace', { name: 'Kahf Group', selfSignup: true }));
    expect(await events('workspace.settings.updated')).toHaveLength(before + 1);
  });
});

describe('workspace roles and the last owner', () => {
  it('a member is 404 and a plain admin cannot grant or touch owner', async () => {
    expect((await w.call(nadia, 'PATCH', `/api/workspace/members/${priya.personId}`, { role: 'admin' })).status).toBe(404);

    const promoted = UpdateWorkspaceMemberResponse.parse(ok(await w.call(omar, 'PATCH', `/api/workspace/members/${priya.personId}`, { role: 'admin' })));
    expect(promoted).toEqual({ personId: priya.personId, role: 'admin' });

    // Priya (admin) reads and edits the settings, but only an owner grants owner or changes an owner.
    ok(await w.call(priya, 'PATCH', '/api/workspace', { name: 'Kahf Software' }));
    expect((await w.call(priya, 'PATCH', `/api/workspace/members/${tariq.personId}`, { role: 'owner' })).status).toBe(403);
    expect((await w.call(priya, 'PATCH', `/api/workspace/members/${omar.personId}`, { role: 'member' })).status).toBe(403);
    const { members } = ListWorkspaceMembersResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/members')));
    expect(members.find((m) => m.personId === omar.personId)?.role).toBe('owner');
    expect(members.find((m) => m.personId === tariq.personId)?.role).toBe('member');
  });

  it('is 404 for an unknown person, 400 for a bad id or role, and 409 when a team member would become a guest', async () => {
    expect((await w.call(omar, 'PATCH', '/api/workspace/members/00000000-0000-7000-8000-00000000ffff', { role: 'member' })).status).toBe(404);
    expect((await w.call(omar, 'PATCH', '/api/workspace/members/not-a-uuid', { role: 'member' })).status).toBe(400);
    expect((await w.call(omar, 'PATCH', `/api/workspace/members/${nadia.personId}`, { role: 'superuser' })).status).toBe(400);
    const res = await w.call(omar, 'PATCH', `/api/workspace/members/${nadia.personId}`, { role: 'guest' });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain('guest');
  });

  it('refuses to demote the only owner, even by that owner', async () => {
    const res = await w.call(omar, 'PATCH', `/api/workspace/members/${omar.personId}`, { role: 'admin' });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: 'conflict', message: expect.stringContaining('at least one owner') });
    const { members } = ListWorkspaceMembersResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/members')));
    expect(members.find((m) => m.personId === omar.personId)?.role).toBe('owner');
  });

  it('with a second owner the first may step down, and the last one is protected again', async () => {
    ok(await w.call(omar, 'PATCH', `/api/workspace/members/${tariq.personId}`, { role: 'owner' }));
    ok(await w.call(omar, 'PATCH', `/api/workspace/members/${omar.personId}`, { role: 'admin' }));

    const res = await w.call(tariq, 'PATCH', `/api/workspace/members/${tariq.personId}`, { role: 'member' });
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toContain('at least one owner');

    const changed = await events('workspace.member.role_changed');
    expect(changed.map((e) => {
      const p = e.payload as { personId: string; previousRole: string; role: string };
      return [p.personId, p.previousRole, p.role];
    })).toEqual([
      [priya.personId, 'member', 'admin'],
      [tariq.personId, 'member', 'owner'],
      [omar.personId, 'owner', 'admin'],
    ]);
    for (const e of changed) expect(() => parseEvent(eventToRaw(e))).not.toThrow();
    expect((changed[2]?.payload as { changedBy: string }).changedBy).toBe(omar.personId);
  });

  it('holds for every writer: not even the system role can delete or demote the final owner, but can once another owner exists', async () => {
    const attempt = (sql: string, values: unknown[] = []) => w.system(async (tx) => (await tx.query(sql, values)).rowCount);
    await expect(attempt('DELETE FROM app.workspace_members WHERE person_id = $1', [tariq.personId])).rejects.toMatchObject({ code: '23514' });
    await expect(attempt("UPDATE app.workspace_members SET role = 'admin' WHERE person_id = $1", [tariq.personId])).rejects.toMatchObject({ code: '23514' });
    await expect(attempt("UPDATE app.workspace_members SET workspace_id = '00000000-0000-7000-8000-00000000a999' WHERE person_id = $1", [tariq.personId])).rejects.toBeTruthy();

    // A second owner makes the first removable again.
    await attempt("UPDATE app.workspace_members SET role = 'owner' WHERE person_id = $1", [omar.personId]);
    expect(await attempt("UPDATE app.workspace_members SET role = 'member' WHERE person_id = $1", [tariq.personId])).toBe(1);
    // Saving an owner row as an owner is not a demotion.
    expect(await attempt("UPDATE app.workspace_members SET role = 'owner' WHERE person_id = $1", [omar.personId])).toBe(1);
  });

  it('two owners stepping down at the same moment cannot leave the workspace without one', async () => {
    await w.system(async (tx) => {
      await tx.query("UPDATE app.workspace_members SET role = 'owner' WHERE person_id = $1", [tariq.personId]);
    });
    const results = await Promise.allSettled([
      w.call(omar, 'PATCH', `/api/workspace/members/${omar.personId}`, { role: 'member' }),
      w.call(tariq, 'PATCH', `/api/workspace/members/${tariq.personId}`, { role: 'member' }),
    ]);
    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
    expect([...statuses].sort()).toEqual([200, 409]);
    const owners = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.workspace_members WHERE role = 'owner'")).rows[0]?.n);
    expect(owners).toBeGreaterThanOrEqual(1);
  });
});
