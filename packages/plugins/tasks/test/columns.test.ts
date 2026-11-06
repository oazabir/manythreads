import { randomUUID } from 'node:crypto';
import { BoardColumnsResponse, BoardPlacesResponse, CardActivityResponse, CreateTaskResponse, MoveTaskResponse } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startTestServer, type Persona, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Custom board columns (migration 0015) and the bot icon read: who may edit columns, the refusals, a card's place among two columns of one state,
// the state trigger that sends a card back to the first column of its new state, and which bots show on which cards.

const { nadia, omar, sameera } = personas;
const TEAM = TEAM_IDS.Engineering;
let server: TestServer;

const call = async (who: Persona, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
};

const base = '/api/teams/engineering/boards';
async function newBoard(): Promise<string> {
  const res = await call(omar, 'POST', base, { name: `B-${randomUUID().slice(0, 6)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String((res.body['board'] as Record<string, unknown>)['id']);
}
const columnsOf = (body: Record<string, unknown>) => BoardColumnsResponse.parse(body).board.columns;
async function addColumn(boardId: string, name: string, state: string): Promise<string> {
  const res = await call(omar, 'POST', `${base}/${boardId}/columns`, { name, state });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return columnsOf(res.body).find((c) => c.name === name)!.id;
}
async function card(): Promise<string> {
  const res = await call(nadia, 'POST', '/api/teams/engineering/tasks', { title: 'Column card', branch: 'col/card', kind: 'other' });
  expect(res.status).toBe(201);
  return CreateTaskResponse.parse(res.body).task.id;
}

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
}, 120_000);
afterAll(async () => {
  await server?.close();
});

describe('board columns', () => {
  it('lets a lead add, rename, reorder and delete; a member is refused', async () => {
    const boardId = await newBoard();
    expect((await call(nadia, 'POST', `${base}/${boardId}/columns`, { name: 'QA', state: 'verify' })).status).toBe(403);
    const qa = await addColumn(boardId, 'QA', 'verify');
    const list = columnsOf((await call(omar, 'PATCH', `${base}/${boardId}/columns/${qa}`, { name: 'Quality' })).body);
    expect(list.map((c) => c.name)).toEqual(['Open', 'In progress', 'Verify', 'Waiting on a person', 'Done', 'Quality']);
    expect(list.at(-1)).toMatchObject({ id: qa, state: 'verify', title: 'Quality' });
    expect((await call(nadia, 'PATCH', `${base}/${boardId}/columns/${qa}`, { name: 'x' })).status).toBe(403);
    const ids = list.map((c) => c.id);
    const reordered = await call(omar, 'PUT', `${base}/${boardId}/columns/order`, { columnIds: [qa, ...ids.filter((i) => i !== qa)] });
    expect(columnsOf(reordered.body)[0]!.id).toBe(qa);
    expect((await call(nadia, 'PUT', `${base}/${boardId}/columns/order`, { columnIds: ids })).status).toBe(403);
    expect((await call(nadia, 'DELETE', `${base}/${boardId}/columns/${qa}`)).status).toBe(403);
    const gone = await call(omar, 'DELETE', `${base}/${boardId}/columns/${qa}`);
    expect(columnsOf(gone.body)).toHaveLength(5);
  });

  it('refuses a reorder with a stale set of columns, and the last column of a board', async () => {
    const boardId = await newBoard();
    const qa = await addColumn(boardId, 'QA', 'verify');
    const stale = await call(omar, 'PUT', `${base}/${boardId}/columns/order`, { columnIds: ['open', 'done'] });
    expect(stale.status).toBe(409);
    const dup = await call(omar, 'PUT', `${base}/${boardId}/columns/order`, { columnIds: ['open', 'open', 'in_progress', 'verify', 'waiting_on_person', 'done'] });
    expect(dup.status).toBe(409);
    // Delete down to one column.
    for (const id of ['open', 'in_progress', 'verify', 'waiting_on_person', 'done']) expect((await call(omar, 'DELETE', `${base}/${boardId}/columns/${id}`)).status).toBe(200);
    const last = await call(omar, 'DELETE', `${base}/${boardId}/columns/${qa}`);
    expect(last.status).toBe(409);
  });

  it('keeps at most 12 columns', async () => {
    const boardId = await newBoard();
    for (let i = 0; i < 7; i++) await addColumn(boardId, `Extra ${i}`, 'open');
    expect((await call(omar, 'POST', `${base}/${boardId}/columns`, { name: 'One more', state: 'open' })).status).toBe(409);
  });

  it('puts a card in a second column of its state, refuses to delete a column that holds it, and resets the place when the state changes', async () => {
    const boardId = await newBoard();
    const review = await addColumn(boardId, 'Code review', 'verify');
    const qa = await addColumn(boardId, 'QA', 'verify');
    const id = await card();
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${id}/claim`);
    // A column of another state than the card's own is a move; into verify through the rules.
    const toQa = await call(nadia, 'POST', `${base}/${boardId}/move`, { taskId: id, columnId: qa });
    expect(toQa.status, JSON.stringify(toQa.body)).toBe(200);
    expect(MoveTaskResponse.parse(toQa.body).task.state).toBe('verify');
    const places = BoardPlacesResponse.parse((await call(nadia, 'GET', `${base}/${boardId}/places`)).body);
    expect(places.places).toEqual([{ taskId: id, columnId: qa }]);
    expect(places.counts.find((c) => c.columnId === qa)?.total).toBe(1);
    expect(places.counts.find((c) => c.columnId === 'verify')?.total).toBe(0);
    // The delete refusal says how many.
    const refused = await call(omar, 'DELETE', `${base}/${boardId}/columns/${qa}`);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('1 card is in QA');
    // Same-state move to the other column of the state keeps the state and needs no task event.
    const toReview = await call(nadia, 'POST', `${base}/${boardId}/move`, { taskId: id, columnId: review });
    expect(toReview.status).toBe(200);
    expect(BoardPlacesResponse.parse((await call(nadia, 'GET', `${base}/${boardId}/places`)).body).places).toEqual([{ taskId: id, columnId: review }]);
    // A column the card's state does not match: the old `{to}` body means the first column of that state.
    const back = await call(nadia, 'POST', `${base}/${boardId}/move`, { taskId: id, to: 'verify' });
    expect(back.status).toBe(200);
    expect(BoardPlacesResponse.parse((await call(nadia, 'GET', `${base}/${boardId}/places`)).body).places).toEqual([]);
    // A state change by any other door (here: back to in progress) drops the place on every board.
    await call(nadia, 'POST', `${base}/${boardId}/move`, { taskId: id, columnId: qa });
    await ownerSql(server.db.ownerUrl, `UPDATE app.tasks SET state = 'in_progress' WHERE id = $1`, [id]);
    expect(BoardPlacesResponse.parse((await call(nadia, 'GET', `${base}/${boardId}/places`)).body).places).toEqual([]);
    // Now QA holds nothing and can go.
    expect((await call(omar, 'DELETE', `${base}/${boardId}/columns/${qa}`)).status).toBe(200);
  });

  it('answers an unknown column with 409 and still reads a board stored in the older shape', async () => {
    const boardId = await newBoard();
    const id = await card();
    expect((await call(nadia, 'POST', `${base}/${boardId}/move`, { taskId: id, columnId: 'c_nope' })).status).toBe(409);
    expect((await call(nadia, 'POST', `${base}/${boardId}/move`, { taskId: id })).status).toBe(400);
    await ownerSql(server.db.ownerUrl, `UPDATE app.boards SET columns = '[{"state":"open","title":"Todo"},{"state":"done","title":"Finished"}]'::jsonb WHERE id = $1`, [boardId]);
    const read = await call(nadia, 'GET', `${base}/${boardId}`);
    expect(((read.body['board'] as Record<string, unknown>)['columns'] as unknown[])[0]).toEqual({ id: 'open', name: 'Todo', state: 'open', title: 'Todo' });
    const places = BoardPlacesResponse.parse((await call(nadia, 'GET', `${base}/${boardId}/places`)).body);
    expect(places.counts.map((c) => c.columnId)).toEqual(['open', 'done']);
    // An edit of an old board writes the new shape for every column.
    const renamed = columnsOf((await call(omar, 'PATCH', `${base}/${boardId}/columns/open`, { name: 'To do' })).body);
    expect(renamed.map((c) => c.id)).toEqual(['open', 'done']);
  });
});

describe('bot activity on cards', () => {
  async function makeBot(): Promise<string> {
    const botId = randomUUID();
    const actorId = randomUUID();
    await ownerSql(
      server.db.ownerUrl,
      `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, $4, $4, 'agent', 'hermes', 'team', $5, 'active')`,
      [botId, KAHF_WORKSPACE_ID, TEAM, `act-${botId.slice(0, 6)}`, 'a'.repeat(64)],
    );
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [actorId, KAHF_WORKSPACE_ID, botId]);
    return botId;
  }
  const activity = async (who: Persona) => {
    const res = await call(who, 'GET', '/api/teams/engineering/tasks/activity');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return CardActivityResponse.parse(res.body).items;
  };

  it('shows a live run and a queued run on a card, and nothing once the run has ended', async () => {
    const id = await card();
    const botId = await makeBot();
    const actor = (await ownerSql(server.db.ownerUrl, `SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId]))[0]!['id'] as string;
    const run = (
      await ownerSql(
        server.db.ownerUrl,
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, task_id) VALUES ($1, $2, $3, 'task_assigned', 'running', $4) RETURNING id`,
        [KAHF_WORKSPACE_ID, botId, TEAM, id],
      )
    )[0]!['id'] as string;
    expect((await activity(nadia)).find((i) => i.taskId === id)?.bots).toEqual([{ actorId: actor, phase: 'running' }]);
    // Another team's member sees nothing.
    expect((await call(sameera, 'GET', '/api/teams/engineering/tasks/activity')).status).toBe(403);
    await ownerSql(server.db.ownerUrl, `UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1`, [run]);
    expect((await activity(nadia)).find((i) => i.taskId === id)).toBeUndefined();
    // A run job waiting in the queue shows as queued.
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.jobs (queue, payload) VALUES ('runtime-hermes.run', $1::jsonb)`, [JSON.stringify({ teamId: TEAM, botId, taskId: id })]);
    expect((await activity(nadia)).find((i) => i.taskId === id)?.bots).toEqual([{ actorId: actor, phase: 'queued' }]);
    await ownerSql(server.db.ownerUrl, `DELETE FROM app.jobs WHERE payload->>'taskId' = $1`, [id]);
  });
});
