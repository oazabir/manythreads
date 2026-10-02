import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { eventRegistry, parseEvent, type EventType } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type World } from '../world.ts';

const { omar, nadia, priya } = personas;

// Event contract tests (pnpm test:events): the workspace settings and role events are stored in the shape their registered
// schema accepts, as the acting admin, at workspace level (no team), and a refused request emits nothing.

const EMITTED = ['workspace.settings.updated', 'workspace.member.role_changed'] as const satisfies readonly EventType[];

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const stored = (): Promise<EventRow[]> =>
  w.system(
    async (tx) =>
      (
        await tx.query<EventRow>(
          'SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = ANY($1::text[]) ORDER BY id',
          [[...EMITTED]],
        )
      ).rows,
  );

describe('workspace events', () => {
  it('registers both events at schema version 1', () => {
    for (const type of EMITTED) expect(Object.keys(eventRegistry[type])).toEqual(['1']);
  });

  it('are emitted by the routes, parse against the registry, and carry the acting admin and no team', async () => {
    expect((await w.call(omar, 'PATCH', '/api/workspace', { name: 'Kahf Group', selfSignup: true })).status).toBe(200);
    expect((await w.call(omar, 'PATCH', `/api/workspace/members/${priya.personId}`, { role: 'admin' })).status).toBe(200);
    const rows = await stored();
    expect(rows.map((r) => r.type)).toEqual(['workspace.settings.updated', 'workspace.member.role_changed']);
    for (const r of rows) {
      expect(parseEvent(eventToRaw(r)).type).toBe(r.type);
      expect(r.workspace_id).toBe(omar.workspaceId);
      expect(r.actor_id).toBe(omar.actorId);
      expect(r.team_id).toBeNull();
    }
    expect(rows[0]?.payload).toMatchObject({ personId: omar.personId, changes: { name: 'Kahf Group', selfSignup: true } });
    expect(rows[1]?.payload).toMatchObject({ personId: priya.personId, previousRole: 'member', role: 'admin', changedBy: omar.personId });
  });

  it('a refused, invalid or no-op request emits nothing', async () => {
    const n = (await stored()).length;
    expect((await w.call(nadia, 'PATCH', '/api/workspace', { name: 'Nope' })).status).toBe(404);
    expect((await w.call(omar, 'PATCH', '/api/workspace', {})).status).toBe(400);
    expect((await w.call(omar, 'PATCH', '/api/workspace', { name: 'Kahf Group' })).status).toBe(200);
    expect((await w.call(omar, 'PATCH', `/api/workspace/members/${omar.personId}`, { role: 'admin' })).status).toBe(409);
    expect((await w.call(priya, 'PATCH', `/api/workspace/members/${omar.personId}`, { role: 'member' })).status).toBe(403);
    expect((await w.call(omar, 'PATCH', `/api/workspace/members/${priya.personId}`, { role: 'admin' })).status).toBe(200);
    expect((await stored()).length).toBe(n);
  });
});
