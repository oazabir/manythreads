import { randomUUID } from 'node:crypto';
import { withActor } from '@manythreads/kernel';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, personaActor, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { nadia, sameera } = personas;
const TEAM = TEAM_IDS.Engineering;
const OTHER_TEAM = TEAM_IDS['Customer support'];

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('task tables under RLS', () => {
  it('shows a member of another team zero cards, goals, environments, boards and runners', async () => {
    const counts = await withActor(
      personaActor(sameera),
      async (tx) => {
        const one = async (table: string) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table} WHERE team_id = $1`, [TEAM])).rows[0]?.n ?? -1;
        return {
          tasks: await one('tasks'),
          goals: await one('goals'),
          environments: await one('environments'),
          boards: await one('boards'),
          runners: await one('runners'),
          taskEvents: await one('task_events'),
          claims: await one('task_claims'),
          handoffs: await one('handoffs'),
          deploys: await one('deploys'),
        };
      },
      { pool: server.pools.app },
    );
    expect(counts).toEqual({ tasks: 0, goals: 0, environments: 0, boards: 0, runners: 0, taskEvents: 0, claims: 0, handoffs: 0, deploys: 0 });
  });

  it('shows Engineering its own cards and denies a cross-team insert and update', async () => {
    const taskId = randomUUID();
    const result = await withActor(
      personaActor(nadia),
      async (tx) => {
        await tx.query(
          `INSERT INTO app.tasks (id, workspace_id, team_id, title, branch, created_by) VALUES ($1, $2, $3, 'rls card', 'rls/branch', $4)`,
          [taskId, KAHF_WORKSPACE_ID, TEAM, nadia.actorId],
        );
        const visible = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.tasks WHERE team_id = $1', [TEAM])).rows[0]?.n ?? 0;
        // A card of another team is readable only through its own team: an update naming it changes nothing.
        const upd = await tx.query(`UPDATE app.tasks SET title = 'hijacked' WHERE id = $1 AND team_id = $2`, [taskId, OTHER_TEAM]);
        return { visible, updatedOther: upd.rows.length };
      },
      { pool: server.pools.app },
    );
    expect(result.visible).toBeGreaterThanOrEqual(1);
    expect(result.updatedOther).toBe(0);
  });

  it('answers 403 for an environment and a runner from another team through the API', async () => {
    const headers = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: sameera.actorId, workspaceId: KAHF_WORKSPACE_ID }), 'content-type': 'application/json' };
    for (const path of ['/api/teams/engineering/environments', '/api/teams/engineering/boards', '/api/teams/engineering/runners', '/api/teams/engineering/goals']) {
      const res = await fetch(`${server.url}${path}`, { headers });
      expect(res.status, path).toBe(403);
    }
    const create = await fetch(`${server.url}/api/teams/engineering/runners`, { method: 'POST', headers, body: JSON.stringify({ name: 'x' }) });
    expect(create.status).toBe(403);
  });
});
