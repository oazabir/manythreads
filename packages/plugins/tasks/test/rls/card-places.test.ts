import { randomUUID } from 'node:crypto';
import { withActor } from '@manythreads/kernel';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, personaActor, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The place of a card among the columns of a board (migration 0015): readable by the teams a person can read, written only by the door.

const { nadia, sameera } = personas;
const TEAM = TEAM_IDS.Engineering;

let server: TestServer;
let boardId = '';
let taskId = '';

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  boardId = (
    await ownerSql<{ id: string }>(
      server.db.ownerUrl,
      `INSERT INTO app.boards (workspace_id, team_id, name, columns, created_by) VALUES ($1, $2, 'P', $3::jsonb, $4) RETURNING id`,
      [KAHF_WORKSPACE_ID, TEAM, JSON.stringify([{ id: 'a', name: 'A', state: 'open', title: 'A' }, { id: 'b', name: 'B', state: 'open', title: 'B' }]), nadia.actorId],
    )
  )[0]!.id;
  taskId = (
    await ownerSql<{ id: string }>(
      server.db.ownerUrl,
      `INSERT INTO app.tasks (workspace_id, team_id, title, branch, kind, created_by) VALUES ($1, $2, 'T', 'x/y', 'other', $3) RETURNING id`,
      [KAHF_WORKSPACE_ID, TEAM, nadia.actorId],
    )
  )[0]!.id;
}, 120_000);
afterAll(async () => {
  await server?.close();
});

describe('board_card_places', () => {
  it('cannot be written directly by the app role, but the door places a card for a team poster', async () => {
    await expect(
      withActor(personaActor(nadia), (tx) => tx.query(`INSERT INTO app.board_card_places (board_id, task_id, team_id, column_id, state) VALUES ($1, $2, $3, 'b', 'open')`, [boardId, taskId, TEAM]), {
        pool: server.pools.app,
      }),
    ).rejects.toThrow();
    const placed = await withActor(personaActor(nadia), async (tx) => (await tx.query<{ o: string }>(`SELECT app.tasks_board_place($1, $2, 'b') AS o`, [boardId, taskId])).rows[0]?.o, {
      pool: server.pools.app,
    });
    expect(placed).toBe('placed');
    const wrongColumn = await withActor(personaActor(nadia), async (tx) => (await tx.query<{ o: string }>(`SELECT app.tasks_board_place($1, $2, 'zz') AS o`, [boardId, taskId])).rows[0]?.o, {
      pool: server.pools.app,
    });
    expect(wrongColumn).toBe('no_column');
    // The first column of a state is the default and keeps no row.
    await withActor(personaActor(nadia), (tx) => tx.query(`SELECT app.tasks_board_place($1, $2, 'a')`, [boardId, taskId]), { pool: server.pools.app });
    const rows = await ownerSql(server.db.ownerUrl, `SELECT 1 FROM app.board_card_places WHERE board_id = $1`, [boardId]);
    expect(rows).toHaveLength(0);
  });

  it('shows a person of another team nothing, and the door refuses them', async () => {
    await ownerSql(server.db.ownerUrl, `INSERT INTO app.board_card_places (board_id, task_id, team_id, column_id, state) VALUES ($1, $2, $3, 'b', 'open')`, [boardId, taskId, TEAM]);
    const seen = await withActor(personaActor(sameera), async (tx) => (await tx.query(`SELECT 1 FROM app.board_card_places WHERE board_id = $1`, [boardId])).rows.length, { pool: server.pools.app });
    expect(seen).toBe(0);
    const out = await withActor(personaActor(sameera), async (tx) => (await tx.query<{ o: string }>(`SELECT app.tasks_board_place($1, $2, 'a') AS o`, [boardId, randomUUID()])).rows[0]?.o, {
      pool: server.pools.app,
    });
    expect(out).toBe('not_found');
    const mine = await withActor(personaActor(nadia), async (tx) => (await tx.query(`SELECT 1 FROM app.board_card_places WHERE board_id = $1`, [boardId])).rows.length, { pool: server.pools.app });
    expect(mine).toBe(1);
  });
});
