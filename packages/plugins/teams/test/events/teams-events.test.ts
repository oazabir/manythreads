import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { eventRegistry, parseEvent, type EventType } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from '../world.ts';

const { omar, nadia, rafi } = personas;

// Event contract tests (pnpm test:events): every event the teams plugin emits is stored in the shape its registered schema
// accepts, with the right team column, and nothing else is emitted by the mutations below.

const EMITTED = [
  'workspace.team.created',
  'workspace.team.renamed',
  'workspace.team.archived',
  'workspace.team.unarchived',
  'team.template.applied',
  'team.member.added',
  'team.member.removed',
  'team.role.changed',
  'team.tag.created',
  'team.tag.deleted',
  'team.tag.assigned',
  'team.tag.removed',
  'workspace.invitation.created',
  'workspace.invitation.accepted',
] as const satisfies readonly EventType[];

let w: World;
let before: string | null = null;
beforeAll(async () => {
  w = await createWorld();
  before = await w.system(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null);

  const call = async (who: Parameters<World['call']>[0], method: string, path: string, body?: unknown): Promise<void> => {
    const res = await w.call(who, method, path, body);
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  };
  await call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'platform' });
  await call(omar, 'PATCH', '/api/teams/platform', { name: 'Platform' });
  const invite = await w.call(omar, 'POST', '/api/teams/platform/invitations', { email: nadia.email });
  await call(null, 'POST', `/api/invitations/${(invite.body as { token: string }).token}/accept`, {});
  await call(omar, 'POST', '/api/teams/platform/members', { personId: rafi.personId });
  await call(omar, 'PATCH', `/api/teams/platform/members/${rafi.personId}`, { role: 'lead' });
  await call(omar, 'PUT', `/api/teams/platform/members/${rafi.personId}/tags/role:release-manager`);
  await call(omar, 'DELETE', `/api/teams/platform/members/${rafi.personId}/tags/role:release-manager`);
  await call(omar, 'POST', '/api/teams/platform/tags', { name: 'role:triage' });
  await call(omar, 'DELETE', '/api/teams/platform/tags/role:triage');
  await call(omar, 'DELETE', `/api/teams/platform/members/${rafi.personId}`);
  await call(omar, 'POST', '/api/teams/platform/archive');
  await call(omar, 'POST', '/api/teams/platform/unarchive');
  await call(omar, 'POST', '/api/invitations', { email: 'ops@kahf.example', role: 'admin' });
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const stored = (): Promise<EventRow[]> =>
  w.system(async (tx) => {
    const res = await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
       WHERE ($1::uuid IS NULL OR id > $1::uuid) AND (type = ANY($2::text[])) ORDER BY id`,
      [before, [...EMITTED]],
    );
    return res.rows;
  });

describe('team events', () => {
  it('registers every event the plugin declares, at schema version 1', () => {
    for (const type of EMITTED) expect(Object.keys(eventRegistry[type])).toEqual(['1']);
  });

  it('every stored event parses against its registered schema', async () => {
    const rows = await stored();
    expect(rows.length).toBeGreaterThanOrEqual(EMITTED.length);
    for (const row of rows) {
      const parsed = parseEvent(eventToRaw(row));
      expect(parsed.type).toBe(row.type);
    }
  });

  it('all fourteen types were emitted, as the acting person, in the team they concern', async () => {
    const rows = await stored();
    expect([...new Set(rows.map((r) => r.type))].sort()).toEqual([...EMITTED].sort());
    const team = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'platform'")).rows[0]?.id);
    for (const row of rows) {
      expect(row.workspace_id).toBe(omar.workspaceId);
      if (row.type === 'workspace.invitation.accepted') {
        // Written as the person who accepted, who had no session yet.
        expect(row.actor_id).toBe(nadia.actorId);
      } else {
        expect(row.actor_id).toBe(omar.actorId);
      }
      const isWorkspaceInvite = row.type === 'workspace.invitation.created' && (row.payload as { teamId: unknown }).teamId === null;
      if (!isWorkspaceInvite) expect(row.team_id).toBe(team);
    }
  });

  it('payloads carry what an audit needs and never a token', async () => {
    const rows = await stored();
    const of = (type: string) => rows.filter((r) => r.type === type).map((r) => r.payload as Record<string, unknown>);
    expect(of('workspace.team.created')[0]).toMatchObject({ slug: 'platform', name: 'Engineering', template: 'engineering' });
    expect(of('team.template.applied')[0]).toMatchObject({ templateId: 'engineering', templateVersion: 1, slug: 'platform' });
    expect(of('workspace.team.renamed')[0]).toMatchObject({ previousName: 'Engineering', name: 'Platform' });
    expect(of('team.role.changed')[0]).toMatchObject({ personId: rafi.personId, previousRole: 'member', role: 'lead' });
    expect(of('team.member.removed')[0]).toMatchObject({ personId: rafi.personId, role: 'lead' });
    expect(of('team.tag.assigned')[0]).toMatchObject({ tag: 'role:release-manager', personId: rafi.personId });
    expect(of('team.tag.deleted')[0]).toMatchObject({ tag: 'role:triage', removedFrom: [] });
    expect(of('workspace.invitation.accepted')[0]).toMatchObject({ personId: nadia.personId, role: 'member', createdPerson: false });
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/token/i);
  });

  it('a rejected request emits nothing', async () => {
    const count = async (): Promise<number> => (await stored()).length;
    const n = await count();
    expect((await w.call(nadia, 'PATCH', '/api/teams/platform', { name: 'Nope' })).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/teams/from-template', { templateId: 'research' })).status).toBe(403);
    expect((await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'engineering', slug: 'platform' })).status).toBe(200);
    expect(await count()).toBe(n);
  });
});
