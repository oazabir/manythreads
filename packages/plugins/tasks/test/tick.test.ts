import { randomUUID } from 'node:crypto';
import { ListTaskEventsResponse, TickTaskResponse } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startTestServer, type Persona, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Ticking a box of a card's checklist (PLAN P14-19): the server changes one character of the description, refuses a stale tick, keeps the card's
// history, and lets in only a person who can post in the card's team.

const { nadia, priya, sameera } = personas;
let server: TestServer;

const call = async (who: Persona, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
};

const LIST = ['Steps', '', '- [ ] write the test', '- [x] read the plan', '```', '- [ ] not a box', '```', '- [ ] ship it'].join('\n');

async function card(description = LIST, kind = 'code'): Promise<string> {
  const res = await call(nadia, 'POST', '/api/teams/engineering/tasks', { kind, title: 'Checklist card', branch: `fix/tick-${Math.random().toString(36).slice(2, 8)}`, description });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body['task'] as { id: string }).id;
}
const tick = (who: Persona, id: string, body: unknown) => call(who, 'POST', `/api/teams/engineering/tasks/${id}/tick`, body);
const descriptionOf = async (id: string): Promise<string> => ((await call(nadia, 'GET', `/api/teams/engineering/tasks/${id}`)).body['task'] as { description: string }).description;
const eventsOf = async (id: string) => ListTaskEventsResponse.parse((await call(nadia, 'GET', `/api/teams/engineering/tasks/${id}/events`)).body).items;

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
}, 120_000);
afterAll(async () => {
  await server?.close();
});

describe('POST /api/teams/:slug/tasks/:taskId/tick', () => {
  it('writes [x] and [ ] back into the description, one character, and the history says who and which box', async () => {
    const id = await card();
    const res = await tick(priya, id, { nth: 0, checked: true, text: 'write the test' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(TickTaskResponse.parse(res.body).task.description).toBe(LIST.replace('- [ ] write the test', '- [x] write the test'));
    // the third box counts after the fenced one is skipped
    expect((await tick(nadia, id, { nth: 2, checked: true, text: 'ship it' })).status).toBe(200);
    expect(await descriptionOf(id)).toBe(LIST.replace('- [ ] write the test', '- [x] write the test').replace('- [ ] ship it', '- [x] ship it'));
    expect((await tick(priya, id, { nth: 1, checked: false, text: 'read the plan' })).status).toBe(200);
    expect(await descriptionOf(id)).toContain('- [ ] read the plan');

    const described = (await eventsOf(id)).filter((e) => e.type === 'described');
    expect(described).toHaveLength(3);
    expect(described[0]?.actorId).toBe(priya.actorId);
    expect(described[0]?.data).toMatchObject({ tick: { nth: 0, checked: true }, afterLength: LIST.length });
    // never the text itself
    expect(JSON.stringify(described[0]?.data)).not.toContain('write the test');
  });

  it('writes nothing for a box already in that state', async () => {
    const id = await card();
    expect((await tick(nadia, id, { nth: 1, checked: true, text: 'read the plan' })).status).toBe(200);
    expect(await descriptionOf(id)).toBe(LIST);
    expect((await eventsOf(id)).filter((e) => e.type === 'described')).toHaveLength(0);
  });

  it('refuses a tick when the box with that number now says something else, and changes nothing', async () => {
    const id = await card();
    const res = await tick(nadia, id, { nth: 0, checked: true, text: 'a line that was rewritten' });
    expect(res.status).toBe(409);
    expect(String((res.body['error'] as { message: string }).message)).toMatch(/changed while you had it open/);
    expect((await tick(nadia, id, { nth: 9, checked: true, text: 'x' })).status).toBe(409);
    expect(await descriptionOf(id)).toBe(LIST);
  });

  it('refuses a finished card, and a person outside the team', async () => {
    const id = await card(LIST, 'content');
    await ownerSql(server.db.ownerUrl, `UPDATE app.tasks SET state = 'done' WHERE id = $1`, [id]);
    const done = await tick(nadia, id, { nth: 0, checked: true, text: 'write the test' });
    expect(done.status).toBe(409);
    expect(String((done.body['error'] as { message: string }).message)).toMatch(/card is done/);

    const open = await card();
    expect((await tick(sameera, open, { nth: 0, checked: true, text: 'write the test' })).status).toBe(403);
    expect(await descriptionOf(open)).toBe(LIST);
  });

  it('lets two people tick different boxes at once and both land (the one that lost the race works its tick out again from the new text)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await card();
      const [a, b] = await Promise.all([tick(nadia, id, { nth: 0, checked: true, text: 'write the test' }), tick(priya, id, { nth: 2, checked: true, text: 'ship it' })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const text = await descriptionOf(id);
      expect(text).toBe(LIST.replace('- [ ] write the test', '- [x] write the test').replace('- [ ] ship it', '- [x] ship it'));
      expect((await eventsOf(id)).filter((e) => e.type === 'described')).toHaveLength(2);
    }
  });

  it('still refuses the loser when the box it meant now says something else', async () => {
    const id = await card();
    const first = await tick(nadia, id, { nth: 0, checked: true, text: 'write the test' });
    expect(first.status).toBe(200);
    // the list was rewritten by a bot (a direct write here) so that box 0 is another line
    await ownerSql(server.db.ownerUrl, `UPDATE app.tasks SET description = replace(description, 'write the test', 'write another test') WHERE id = $1`, [id]);
    expect((await tick(priya, id, { nth: 0, checked: false, text: 'write the test' })).status).toBe(409);
    expect(await descriptionOf(id)).toContain('- [x] write another test');
  });

  it('gives a bot 403: it rewrites a description with tasks.describe, never ticks', async () => {
    const id = await card();
    const botId = randomUUID();
    const actorId = randomUUID();
    await ownerSql(
      server.db.ownerUrl,
      `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, $4, $4, 'agent', 'hermes', 'team', $5, 'active')`,
      [botId, KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, `ticker-${botId.slice(0, 6)}`, 'a'.repeat(64)],
    );
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [actorId, KAHF_WORKSPACE_ID, botId]);
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [TEAM_IDS.Engineering, actorId, KAHF_WORKSPACE_ID]);
    const res = await fetch(`${server.url}/api/teams/engineering/tasks/${id}/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: KAHF_WORKSPACE_ID }) },
      body: JSON.stringify({ nth: 0, checked: true, text: 'write the test' }),
    });
    expect(res.status).toBe(403);
    expect(await descriptionOf(id)).toBe(LIST);
  });

  it('refuses a body with an unknown key', async () => {
    const id = await card();
    expect((await tick(nadia, id, { nth: 0, checked: true, text: 'write the test', description: 'overwrite' })).status).toBe(400);
  });
});
