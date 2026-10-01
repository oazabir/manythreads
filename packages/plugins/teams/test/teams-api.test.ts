import { randomUUID } from 'node:crypto';
import {
  AcceptInvitationResponse,
  ApplyTeamTemplateResponse,
  CreateTeamInvitationResponse,
  CreateInvitationResponse,
  GetTeamResponse,
  GetTeamRosterResponse,
  ListTeamsResponse,
  ListTemplatesResponse,
  ListWorkspaceMembersResponse,
  TeamTemplate,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ActingAs, type World } from './world.ts';

const { omar, nadia, rafi, priya, sameera, tariq, lena } = personas;
const TEAMS = { engineering: '00000000-0000-7000-8000-0000000b0001', marketing: '00000000-0000-7000-8000-0000000b0003' };

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
const errorCode = (res: { body: unknown }): string => (res.body as { error: { code: string } }).error.code;

describe('templates', () => {
  it('lists the five shipped templates, each with Brain', async () => {
    const { templates } = ListTemplatesResponse.parse(ok(await w.call(omar, 'GET', '/api/templates')));
    expect(templates.map((t) => t.id)).toEqual(['customer-support', 'engineering', 'marketing', 'product-design', 'research']);
    for (const t of templates) expect(t.bots.some((b) => b.slug === 'brain')).toBe(true);
  });

  it('returns one template with its TEAM.md, 404 for an unknown id, 401 without an actor', async () => {
    const body = ok<{ template: unknown }>(await w.call(nadia, 'GET', '/api/templates/engineering'));
    const t = TeamTemplate.parse(body.template);
    expect(t.channels.map((c) => c.name)).toEqual(['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup']);
    expect(t.teamMd).toContain('name: Engineering');
    expect((await w.call(nadia, 'GET', '/api/templates/nope')).status).toBe(404);
    expect((await w.call(null, 'GET', '/api/templates')).status).toBe(401);
  });
});

describe('apply a template (P2-08)', () => {
  let teamId = '';

  it('creates the team with Omar as lead, the stored definition, pending TEAM.md and role tags', async () => {
    const res = await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'platform' });
    const { team, created } = ApplyTeamTemplateResponse.parse(ok(res, 201));
    teamId = team.id;
    expect(created).toBe(true);
    expect(team).toMatchObject({ slug: 'platform', name: 'Engineering', template: 'engineering', myRole: 'lead', memberCount: 1 });
    const def = TeamTemplate.parse(team.templateDefinition);
    expect(def.channels.map((c) => c.name)).toEqual(['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup']);
    expect(def.board.name).toBeTruthy();
    expect(def.bots.map((b) => b.name)).toContain('Brain');

    const roster = GetTeamRosterResponse.parse(ok(await w.call(omar, 'GET', '/api/teams/platform/roster')));
    expect(roster.members.map((m) => [m.displayName, m.role])).toEqual([['Omar', 'lead']]);

    await w.system(async (tx) => {
      const files = await tx.query<{ files: Record<string, string> }>('SELECT files FROM app.team_pending_files WHERE team_id = $1', [teamId]);
      expect(files.rows).toHaveLength(1);
      expect(files.rows[0]?.files['TEAM.md']).toBe(def.teamMd);
      const tags = await tx.query<{ name: string }>(
        'SELECT r.name FROM app.team_role_tags t JOIN app.roles r ON r.id = t.role_id WHERE t.team_id = $1 ORDER BY r.name',
        [teamId],
      );
      expect(tags.rows.map((r) => r.name)).toEqual(['role:on-call', 'role:release-manager', 'role:reviewer']);
    });
  });

  it('applying twice duplicates nothing and returns the existing team', async () => {
    const again = ApplyTeamTemplateResponse.parse(
      ok(await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'platform' })),
    );
    expect(again.created).toBe(false);
    expect(again.team.id).toBe(teamId);
    await Promise.all([
      w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'platform' }),
      w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'platform' }),
    ]);
    await w.system(async (tx) => {
      const count = async (sql: string): Promise<number> =>
        (await tx.query<{ n: number }>(sql, sql.includes('$1') ? [teamId] : [])).rows[0]?.n ?? -1;
      expect(await count("SELECT count(*)::int AS n FROM app.teams WHERE slug = 'platform'")).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM app.team_members WHERE team_id = $1')).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM app.team_pending_files WHERE team_id = $1')).toBe(1);
      expect(await count('SELECT count(*)::int AS n FROM app.team_role_tags WHERE team_id = $1')).toBe(3);
      expect(await count("SELECT count(*)::int AS n FROM app.events WHERE type = 'team.template.applied' AND team_id = $1")).toBe(1);
      expect(await count("SELECT count(*)::int AS n FROM app.events WHERE type = 'workspace.team.created' AND team_id = $1")).toBe(1);
    });
  });

  it('refuses a slug taken by another template or a hand-made team, an unknown template, and non-admins', async () => {
    const seeded = await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'engineering' });
    expect(seeded.status).toBe(409);
    expect(errorCode(seeded)).toBe('conflict');
    expect((await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'marketing', slug: 'platform' })).status).toBe(409);
    expect((await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'nope' })).status).toBe(404);
    expect((await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'research', extra: 1 })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/teams/from-template', { templateId: 'research' })).status).toBe(403);
    expect((await w.call(lena, 'POST', '/api/teams/from-template', { templateId: 'research' })).status).toBe(403);
  });

  it('defaults name and slug from the template and creates blank teams', async () => {
    const res = ApplyTeamTemplateResponse.parse(ok(await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'research' }), 201));
    expect(res.team).toMatchObject({ slug: 'research', name: 'Research' });
    const blank = ok<{ team: { slug: string; myRole: string; template: unknown } }>(
      await w.call(omar, 'POST', '/api/teams', { name: 'Growth Lab' }),
      201,
    );
    expect(blank.team).toMatchObject({ slug: 'growth-lab', myRole: 'lead', template: null });
    expect((await w.call(omar, 'POST', '/api/teams', { name: 'Growth Lab' })).status).toBe(409);
    expect((await w.call(omar, 'POST', '/api/teams', { name: '!!!' })).status).toBe(400);
    expect((await w.call(tariq, 'POST', '/api/teams', { name: 'Tariq team' })).status).toBe(403);
  });
});

describe('visibility and denial (criterion 6)', () => {
  const stub: Record<string, string> = {};

  beforeAll(async () => {
    for (const [name, teamId] of Object.entries(TEAMS)) {
      const res = ok<{ id: string }>(await w.call(omar, 'POST', '/api/test/stub-resources', { teamId, name }), 201);
      stub[name] = res.id;
    }
  });

  it('Lena (guest, no team): empty list, 403 on the team and on its stub resource', async () => {
    expect(ListTeamsResponse.parse(ok(await w.call(lena, 'GET', '/api/teams'))).teams).toEqual([]);
    expect((await w.call(lena, 'GET', '/api/teams/engineering')).status).toBe(403);
    expect((await w.call(lena, 'GET', '/api/teams/engineering/roster')).status).toBe(403);
    expect((await w.call(lena, 'GET', `/api/test/stub-resources/${stub['engineering']}`)).status).toBe(403);
  });

  it('Nadia: 403 on Marketing and its stub resource, 200 on Engineering and its stub resource', async () => {
    expect((await w.call(nadia, 'GET', '/api/teams/marketing')).status).toBe(403);
    expect((await w.call(nadia, 'GET', `/api/test/stub-resources/${stub['marketing']}`)).status).toBe(403);
    const eng = GetTeamResponse.parse(ok(await w.call(nadia, 'GET', '/api/teams/engineering')));
    expect(eng.team).toMatchObject({ slug: 'engineering', myRole: 'member' });
    ok(await w.call(nadia, 'GET', `/api/test/stub-resources/${stub['engineering']}`));
  });

  it('Priya sees both of her teams; Sameera only hers and nothing of Engineering', async () => {
    const priyaTeams = ListTeamsResponse.parse(ok(await w.call(priya, 'GET', '/api/teams'))).teams.map((t) => t.slug);
    expect(priyaTeams).toEqual(expect.arrayContaining(['engineering', 'marketing']));
    expect(priyaTeams).not.toContain('customer-support');
    for (const id of Object.values(stub)) ok(await w.call(priya, 'GET', `/api/test/stub-resources/${id}`));

    const sameeraTeams = ListTeamsResponse.parse(ok(await w.call(sameera, 'GET', '/api/teams'))).teams.map((t) => t.slug);
    expect(sameeraTeams).toEqual(['customer-support']);
    expect((await w.call(sameera, 'GET', '/api/teams/engineering')).status).toBe(403);
    expect((await w.call(sameera, 'GET', '/api/teams/engineering/roster')).status).toBe(403);
    expect((await w.call(sameera, 'GET', `/api/test/stub-resources/${stub['engineering']}`)).status).toBe(403);
    expect((await w.call(sameera, 'GET', `/api/test/stub-resources/${randomUUID()}`)).status).toBe(403);
  });

  it('a missing team is 404 for a workspace admin and 403 for everyone else (existence is not revealed)', async () => {
    expect((await w.call(omar, 'GET', '/api/teams/does-not-exist')).status).toBe(404);
    expect((await w.call(nadia, 'GET', '/api/teams/does-not-exist')).status).toBe(403);
    expect((await w.call(omar, 'GET', '/api/teams/marketing')).status).toBe(200);
  });

  it('workspace members: admin sees roles and tags; non-admins and guests get 404', async () => {
    const { members } = ListWorkspaceMembersResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/members')));
    expect(members).toHaveLength(7);
    expect(members.find((m) => m.displayName === 'Omar')?.role).toBe('owner');
    expect(members.find((m) => m.displayName === 'Lena')?.role).toBe('guest');
    expect(members.find((m) => m.displayName === 'Rafi')?.tags).toEqual(['role:on-call']);
    for (const p of [nadia, priya, sameera, tariq, lena]) expect((await w.call(p, 'GET', '/api/workspace/members')).status).toBe(404);
    expect((await w.call(null, 'GET', '/api/workspace/members')).status).toBe(401);
  });
});

describe('invitations, roster, roles and tags (P2-09)', () => {
  const platformInvites: Record<string, string> = {};
  const people: Record<string, ActingAs> = {};

  it('Omar invites Nadia and Rafi to the new team; accepting seats them (existing people, no duplicates)', async () => {
    for (const p of [nadia, rafi]) {
      const res = CreateTeamInvitationResponse.parse(
        ok(await w.call(omar, 'POST', '/api/teams/platform/invitations', { email: p.email.toUpperCase() }), 201),
      );
      expect(res.invitation).toMatchObject({ email: p.email, role: 'member', acceptedAt: null, teamId: expect.any(String) });
      expect(res.invitation.grant).toEqual({ teamRole: 'member' });
      platformInvites[p.key] = res.token;
    }
    // Only the hash is stored.
    await w.system(async (tx) => {
      const rows = await tx.query<{ token_hash: Buffer }>('SELECT token_hash FROM app.invitations WHERE team_id IS NOT NULL');
      for (const t of Object.values(platformInvites)) {
        expect(rows.rows.some((r) => r.token_hash.toString('utf8') === t)).toBe(false);
      }
    });
    const pending = ok<{ invitations: unknown[] }>(await w.call(omar, 'GET', '/api/teams/platform/invitations'));
    expect(pending.invitations).toHaveLength(2);

    const info = ok<{ teamName: string; invitedBy: string; email: string }>(
      await w.call(null, 'GET', `/api/invitations/${platformInvites['nadia']}`),
    );
    expect(info).toMatchObject({ teamName: 'Engineering', invitedBy: 'Omar', email: nadia.email });

    for (const p of [nadia, rafi]) {
      const accepted = AcceptInvitationResponse.parse(
        ok(await w.call(null, 'POST', `/api/invitations/${platformInvites[p.key]}/accept`, {})),
      );
      expect(accepted).toMatchObject({ personId: p.personId, workspaceRole: 'member', teamRole: 'member', createdPerson: false });
    }
    const roster = GetTeamRosterResponse.parse(ok(await w.call(omar, 'GET', '/api/teams/platform/roster')));
    expect(roster.members.map((m) => m.displayName)).toEqual(['Omar', 'Nadia', 'Rafi']);
    // Nobody was duplicated by accepting.
    await w.system(async (tx) => {
      const n = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.people WHERE lower(primary_email) = $1', [nadia.email]);
      expect(n.rows[0]?.n).toBe(1);
    });
  });

  it('the token is single use, an unknown token is 404 and an expired one is 410', async () => {
    const again = await w.call(null, 'POST', `/api/invitations/${platformInvites['nadia']}/accept`, {});
    expect(again.status).toBe(410);
    expect(errorCode(again)).toBe('gone');
    expect((await w.call(null, 'GET', `/api/invitations/${platformInvites['nadia']}`)).status).toBe(410);
    expect((await w.call(null, 'POST', `/api/invitations/${'x'.repeat(43)}/accept`, {})).status).toBe(404);

    const fresh = CreateTeamInvitationResponse.parse(
      ok(await w.call(omar, 'POST', '/api/teams/platform/invitations', { email: 'late@kahf.example' }), 201),
    );
    await w.system((tx) =>
      tx.query("UPDATE app.invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [fresh.invitation.id]),
    );
    expect((await w.call(null, 'GET', `/api/invitations/${fresh.token}`)).status).toBe(410);
    expect((await w.call(null, 'POST', `/api/invitations/${fresh.token}/accept`, {})).status).toBe(410);
    await w.system(async (tx) => {
      const n = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.people WHERE primary_email = 'late@kahf.example'");
      expect(n.rows[0]?.n).toBe(0);
    });
  });

  it('a new email becomes a person with an actor, a workspace member and a team member', async () => {
    const inv = CreateTeamInvitationResponse.parse(
      ok(await w.call(omar, 'POST', '/api/teams/platform/invitations', { email: 'Newcomer@Kahf.example' }), 201),
    );
    const accepted = AcceptInvitationResponse.parse(
      ok(await w.call(null, 'POST', `/api/invitations/${inv.token}/accept`, { name: 'Newcomer' })),
    );
    expect(accepted).toMatchObject({ email: 'newcomer@kahf.example', createdPerson: true, workspaceRole: 'member', teamRole: 'member' });
    const actorId = await w.system(async (tx) => {
      const res = await tx.query<{ id: string }>("SELECT id FROM app.actors WHERE kind = 'person' AND ref_id = $1", [accepted.personId]);
      return res.rows[0]?.id;
    });
    expect(actorId).toBeTruthy();
    people['newcomer'] = { actorId: actorId as string, workspaceId: accepted.workspaceId };
    ok(await w.call(people['newcomer'], 'GET', '/api/teams/platform'));
    expect((await w.call(people['newcomer'], 'GET', '/api/teams/marketing')).status).toBe(403);
    // Already on the team: inviting the same address again is refused.
    expect((await w.call(omar, 'POST', '/api/teams/platform/invitations', { email: 'newcomer@kahf.example' })).status).toBe(409);
  });

  it('Omar tags Rafi: the roster shows the tag and the events are recorded', async () => {
    const tagPath = (tag: string): string => `/api/teams/platform/members/${rafi.personId}/tags/${encodeURIComponent(tag)}`;
    const { tag, assigned } = ok<{ tag: { name: string; holders: string[] }; assigned: boolean }>(
      await w.call(omar, 'PUT', tagPath('role:release-manager')),
    );
    expect(assigned).toBe(true);
    expect(tag).toMatchObject({ name: 'role:release-manager', holders: [rafi.personId] });
    const roster = GetTeamRosterResponse.parse(ok(await w.call(omar, 'GET', '/api/teams/platform/roster')));
    // Rafi was already on call in the seeded world, and the new team defines that tag too.
    expect(roster.members.find((m) => m.displayName === 'Rafi')?.tags).toEqual(['role:on-call', 'role:release-manager']);
    expect(roster.members.find((m) => m.displayName === 'Nadia')?.tags).toEqual([]);
    // Idempotent: no second assignment, no second event; a tag already shown for him is not a new assignment either.
    expect(ok<{ assigned: boolean }>(await w.call(omar, 'PUT', tagPath('role:release-manager'))).assigned).toBe(false);
    expect(ok<{ assigned: boolean }>(await w.call(omar, 'PUT', tagPath('role:on-call'))).assigned).toBe(false);
    await w.system(async (tx) => {
      const ev = await tx.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM app.events
         WHERE type IN ('team.tag.assigned', 'workspace.invitation.created', 'workspace.invitation.accepted') ORDER BY id`,
      );
      const assignedEvents = ev.rows.filter((r) => r.type === 'team.tag.assigned');
      expect(assignedEvents.map((r) => r.payload['tag'])).toEqual(['role:release-manager']);
      expect(ev.rows.filter((r) => r.type === 'workspace.invitation.created').length).toBeGreaterThanOrEqual(2);
      expect(ev.rows.filter((r) => r.type === 'workspace.invitation.accepted').length).toBeGreaterThanOrEqual(2);
    });
    // Tags show in the workspace members list too.
    const { members } = ListWorkspaceMembersResponse.parse(ok(await w.call(omar, 'GET', '/api/workspace/members')));
    expect(members.find((m) => m.displayName === 'Rafi')?.tags).toEqual(['role:on-call', 'role:release-manager']);
  });

  it('only a lead or admin changes roles, tags, members and invitations', async () => {
    const asNadia = (m: string, p: string, b?: unknown) => w.call(nadia, m, p, b);
    expect((await asNadia('PATCH', `/api/teams/platform/members/${rafi.personId}`, { role: 'lead' })).status).toBe(403);
    expect((await asNadia('PUT', `/api/teams/platform/members/${rafi.personId}/tags/role:reviewer`)).status).toBe(403);
    expect((await asNadia('POST', '/api/teams/platform/members', { personId: priya.personId })).status).toBe(403);
    expect((await asNadia('POST', '/api/teams/platform/invitations', { email: 'x@kahf.example' })).status).toBe(403);
    expect((await asNadia('PATCH', '/api/teams/platform', { name: 'Nope' })).status).toBe(403);
    expect((await asNadia('POST', '/api/teams/platform/archive')).status).toBe(403);
    expect((await asNadia('POST', '/api/teams/platform/tags', { name: 'role:x' })).status).toBe(403);
    // ...and she can still read the roster.
    ok(await asNadia('GET', '/api/teams/platform/roster'));

    // Omar promotes her; now she can.
    const promoted = ok<{ member: { role: string }; changed: boolean }>(
      await w.call(omar, 'PATCH', `/api/teams/platform/members/${nadia.personId}`, { role: 'lead' }),
    );
    expect(promoted).toMatchObject({ changed: true, member: { role: 'lead' } });
    expect(ok<{ changed: boolean }>(await w.call(omar, 'PATCH', `/api/teams/platform/members/${nadia.personId}`, { role: 'lead' })).changed).toBe(false);
    ok(await asNadia('PUT', `/api/teams/platform/members/${rafi.personId}/tags/role:reviewer`));
    expect((await asNadia('POST', '/api/teams/platform/invitations', { email: 'by-lead@kahf.example' })).status).toBe(201);
    // A lead is not a workspace admin.
    expect((await asNadia('POST', '/api/invitations', { email: 'a@kahf.example', role: 'admin' })).status).toBe(403);
    ok(await w.call(omar, 'PATCH', `/api/teams/platform/members/${nadia.personId}`, { role: 'member' }));
  });

  it('adds, re-adds and removes members; guests and strangers are refused', async () => {
    const added = ok<{ added: boolean; member: { displayName: string } }>(
      await w.call(omar, 'POST', '/api/teams/platform/members', { personId: priya.personId }),
      201,
    );
    expect(added).toMatchObject({ added: true, member: { displayName: 'Priya' } });
    expect(ok<{ added: boolean }>(await w.call(omar, 'POST', '/api/teams/platform/members', { personId: priya.personId })).added).toBe(false);
    expect((await w.call(omar, 'POST', '/api/teams/platform/members', { personId: lena.personId })).status).toBe(409);
    expect((await w.call(omar, 'POST', '/api/teams/platform/members', { personId: randomUUID() })).status).toBe(404);
    expect((await w.call(omar, 'POST', '/api/teams/platform/members', { personId: 'nope' })).status).toBe(400);

    // Removing Rafi drops the team's tags with the seat.
    const removed = ok<{ removed: boolean; tags: string[] }>(await w.call(omar, 'DELETE', `/api/teams/platform/members/${rafi.personId}`));
    expect(removed).toEqual({ removed: true, tags: ['role:on-call', 'role:release-manager', 'role:reviewer'] });
    expect((await w.call(rafi, 'GET', '/api/teams/platform')).status).toBe(403);
    expect((await w.call(omar, 'DELETE', `/api/teams/platform/members/${rafi.personId}`)).status).toBe(404);
    await w.system(async (tx) => {
      const n = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id WHERE rm.person_id = $1 AND r.name IN ('role:on-call', 'role:release-manager', 'role:reviewer')",
        [rafi.personId],
      );
      // The seat took its tags with it, so a tag cannot keep granting access to a team he left.
      expect(n.rows[0]?.n).toBe(0);
    });

    // A member can leave; a member cannot remove someone else.
    expect((await w.call(priya, 'DELETE', `/api/teams/platform/members/${nadia.personId}`)).status).toBe(403);
    ok(await w.call(priya, 'DELETE', `/api/teams/platform/members/${priya.personId}`));
  });

  it('tag CRUD: define, list with holders, delete removes it from holders', async () => {
    const created = ok<{ created: boolean; tag: { name: string; holders: string[] } }>(
      await w.call(omar, 'POST', '/api/teams/platform/tags', { name: 'role:triage' }),
      201,
    );
    expect(created).toMatchObject({ created: true, tag: { name: 'role:triage', holders: [] } });
    expect(ok<{ created: boolean }>(await w.call(omar, 'POST', '/api/teams/platform/tags', { name: 'role:triage' })).created).toBe(false);
    expect((await w.call(omar, 'POST', '/api/teams/platform/tags', { name: 'triage' })).status).toBe(400);
    ok(await w.call(omar, 'PUT', `/api/teams/platform/members/${nadia.personId}/tags/role:triage`));
    const list = ok<{ tags: { name: string; holders: string[] }[] }>(await w.call(omar, 'GET', '/api/teams/platform/tags'));
    expect(list.tags.find((t) => t.name === 'role:triage')?.holders).toEqual([nadia.personId]);
    expect((await w.call(sameera, 'GET', '/api/teams/platform/tags')).status).toBe(403);

    const unassigned = ok<{ removed: boolean }>(await w.call(omar, 'DELETE', `/api/teams/platform/members/${nadia.personId}/tags/role:triage`));
    expect(unassigned.removed).toBe(true);
    ok(await w.call(omar, 'PUT', `/api/teams/platform/members/${nadia.personId}/tags/role:triage`));
    const dropped = ok<{ deleted: boolean; removedFrom: string[] }>(await w.call(omar, 'DELETE', '/api/teams/platform/tags/role:triage'));
    expect(dropped).toEqual({ deleted: true, removedFrom: [nadia.personId] });
    expect((await w.call(omar, 'DELETE', '/api/teams/platform/tags/role:triage')).status).toBe(404);
    // Assigning a tag the team never defined defines it first.
    const auto = ok<{ assigned: boolean }>(await w.call(omar, 'PUT', `/api/teams/platform/members/${nadia.personId}/tags/role:new-tag`));
    expect(auto.assigned).toBe(true);
    expect((await w.call(omar, 'PUT', `/api/teams/platform/members/${lena.personId}/tags/role:new-tag`)).status).toBe(404);
  });

  it('rename, archive and unarchive: leads and admins only; an archived team is read-only', async () => {
    expect(ok<{ team: { name: string } }>(await w.call(omar, 'PATCH', '/api/teams/platform', { name: 'Platform' })).team.name).toBe('Platform');
    expect(ok<{ changed: boolean }>(await w.call(omar, 'POST', '/api/teams/platform/archive')).changed).toBe(true);
    expect(ok<{ changed: boolean }>(await w.call(omar, 'POST', '/api/teams/platform/archive')).changed).toBe(false);
    const slugs = async (q = ''): Promise<string[]> =>
      ListTeamsResponse.parse(ok(await w.call(omar, 'GET', `/api/teams${q}`))).teams.map((t) => t.slug);
    expect(await slugs()).not.toContain('platform');
    expect(await slugs('?includeArchived=true')).toContain('platform');
    expect((await w.call(omar, 'PATCH', '/api/teams/platform', { name: 'Again' })).status).toBe(409);
    expect((await w.call(omar, 'POST', '/api/teams/platform/members', { personId: tariq.personId })).status).toBe(409);
    ok(await w.call(omar, 'GET', '/api/teams/platform/roster'));
    expect(ok<{ changed: boolean }>(await w.call(omar, 'POST', '/api/teams/platform/unarchive')).changed).toBe(true);
    expect((await w.call(sameera, 'PATCH', '/api/teams/platform', { name: 'x' })).status).toBe(403);
  });
});

describe('workspace and guest invitations', () => {
  it('only admins create them; a guest invitation records its channels and carries no team', async () => {
    const body = { email: 'Guest@Partner.example', role: 'guest', channels: [{ teamSlug: 'engineering', channel: '#releases' }] };
    expect((await w.call(nadia, 'POST', '/api/invitations', body)).status).toBe(403);
    expect((await w.call(omar, 'POST', '/api/invitations', { ...body, channels: undefined })).status).toBe(400);
    expect((await w.call(omar, 'POST', '/api/invitations', { email: 'm@x.example', role: 'member', channels: [] })).status).toBe(400);
    expect((await w.call(omar, 'POST', '/api/invitations', { ...body, channels: [{ teamSlug: 'ghost', channel: '#x' }] })).status).toBe(404);

    const res = CreateInvitationResponse.parse(ok(await w.call(omar, 'POST', '/api/invitations', body), 201));
    expect(res.invitation).toMatchObject({ role: 'guest', teamId: null, email: 'guest@partner.example' });
    expect(res.invitation.grant).toEqual({
      channels: [{ teamId: TEAMS.engineering, teamSlug: 'engineering', channel: '#releases' }],
    });

    const accepted = AcceptInvitationResponse.parse(ok(await w.call(null, 'POST', `/api/invitations/${res.token}/accept`, { name: 'Gus' })));
    expect(accepted).toMatchObject({ workspaceRole: 'guest', teamId: null, teamRole: null, createdPerson: true });
    const actorId = await w.system(async (tx) => {
      const r = await tx.query<{ id: string }>("SELECT id FROM app.actors WHERE kind = 'person' AND ref_id = $1", [accepted.personId]);
      return r.rows[0]?.id as string;
    });
    const guest: ActingAs = { actorId, workspaceId: accepted.workspaceId };
    expect(ListTeamsResponse.parse(ok(await w.call(guest, 'GET', '/api/teams'))).teams).toEqual([]);
    expect((await w.call(guest, 'GET', '/api/teams/engineering')).status).toBe(403);
    expect((await w.call(guest, 'GET', '/api/workspace/members')).status).toBe(404);
  });

  it('an invitation promotes an existing guest to member but never lowers anyone', async () => {
    const up = CreateInvitationResponse.parse(ok(await w.call(omar, 'POST', '/api/invitations', { email: lena.email, role: 'member' }), 201));
    const accepted = AcceptInvitationResponse.parse(ok(await w.call(null, 'POST', `/api/invitations/${up.token}/accept`, {})));
    expect(accepted).toMatchObject({ personId: lena.personId, workspaceRole: 'member', createdPerson: false });
    const down = CreateInvitationResponse.parse(
      ok(await w.call(omar, 'POST', '/api/invitations', { email: omar.email, role: 'member' }), 201),
    );
    expect(AcceptInvitationResponse.parse(ok(await w.call(null, 'POST', `/api/invitations/${down.token}/accept`, {}))).workspaceRole).toBe('owner');
  });
});
