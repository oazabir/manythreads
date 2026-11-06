import { randomBytes } from 'node:crypto';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { conflict, json, notFound, requireManage, requireTeam, route } from '@manythreads/sdk';
import {
  AddBoardColumnRequest,
  BoardColumnsResponse,
  BoardPlacesResponse,
  MAX_BOARD_COLUMNS,
  RenameBoardColumnRequest,
  ReorderBoardColumnsRequest,
  TasksBoardUpdatedEvent,
  addBoardColumnRoute,
  boardPlacesRoute,
  deleteBoardColumnRoute,
  readStoredColumn,
  renameBoardColumnRoute,
  reorderBoardColumnsRoute,
  type BoardColumn,
} from '@manythreads/shared';
import { toBoard, type BoardRow } from './rows.ts';

/** Most cards counted per board (the board shows the most recent ones). */
const COUNT_CAP = 2000;

/** The board's stored columns, all in the current shape (an older column gets id = state, name = title). */
const columnsOf = (row: BoardRow): BoardColumn[] => (row.columns ?? []).map(readStoredColumn).filter((c): c is BoardColumn => c !== null);

/** `c_` and eight base36 characters; drawn again by the caller when it clashes with a column of the board. */
const newColumnId = (): string => `c_${[...randomBytes(8)].map((b) => (b % 36).toString(36)).join('')}`;

/** Loads a board of the team and locks the row until the transaction ends, so two edits of one board never interleave. */
async function lockBoard(tx: PluginTx, teamId: string, boardId: string): Promise<BoardRow> {
  const row = (await tx.query<BoardRow>('SELECT * FROM app.boards WHERE id = $1::uuid AND team_id = $2::uuid FOR UPDATE', [boardId, teamId])).rows[0];
  if (!row) throw notFound('No such board');
  return row;
}

async function saveColumns(ctx: PluginContext, tx: PluginTx, row: BoardRow, columns: BoardColumn[], change: TasksBoardUpdatedEvent['change']): Promise<BoardRow> {
  const saved = (
    await tx.query<BoardRow>('UPDATE app.boards SET columns = $2::jsonb WHERE id = $1::uuid RETURNING *', [row.id, JSON.stringify(columns)])
  ).rows[0];
  if (!saved) throw conflict('Could not save the board');
  await ctx.audit.emit(
    tx,
    TasksBoardUpdatedEvent.parse({
      type: 'tasks.board.updated',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      boardId: row.id,
      channelId: row.channel_id,
      actorId: tx.actor.id,
      change,
      columnCount: columns.length,
    }),
  );
  return saved;
}

/**
 * Cards per column of a board. Which cards: a channel board takes the cards filed on it; a team board takes the team's cards through the saved
 * filter (`goalId`, `ownerId`, `kind`). A card is in its place when it has one that still counts as its state, otherwise in the first column of
 * its state. Cards of a state the board has no column for are not counted. The most recent 2000 cards are looked at.
 */
export async function countColumns(tx: PluginTx, row: BoardRow): Promise<Map<string, number>> {
  const values: unknown[] = [row.id, row.team_id, JSON.stringify(columnsOf(row))];
  const where: string[] = ['t.team_id = $2::uuid'];
  if (row.channel_id) where.push('t.board_id = $1::uuid');
  else {
    const filter = row.filter ?? {};
    for (const [key, col, cast] of [['goalId', 't.goal_id', '::uuid'], ['ownerId', 't.owner_id', '::uuid'], ['kind', 't.kind', '']] as const) {
      const v = filter[key];
      if (typeof v === 'string') {
        values.push(v);
        where.push(`${col} = $${values.length}${cast}`);
      }
    }
  }
  const res = await tx.query<{ column_id: string; total: number }>(
    `WITH cols AS (
       SELECT coalesce(c->>'id', c->>'state') AS cid, c->>'state' AS st, n
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS x(c, n)
     ),
     firsts AS (SELECT DISTINCT ON (st) st, cid FROM cols ORDER BY st, n),
     cards AS (SELECT t.id, t.state FROM app.tasks t WHERE ${where.join(' AND ')} ORDER BY t.updated_at DESC, t.id DESC LIMIT ${COUNT_CAP})
     SELECT coalesce(p.column_id, f.cid) AS column_id, count(*)::int AS total
       FROM cards k
       JOIN firsts f ON f.st = k.state
       LEFT JOIN app.board_card_places p ON p.board_id = $1::uuid AND p.task_id = k.id AND p.state = k.state AND p.column_id IN (SELECT cid FROM cols)
      GROUP BY 1`,
    values,
  );
  return new Map(res.rows.map((r) => [r.column_id, r.total]));
}

/** The routes that change a board's columns (a team lead or a workspace admin) and the read of where cards sit. */
export function registerColumnRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...addBoardColumnRoute,
    schema: { body: AddBoardColumnRequest, response: BoardColumnsResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId } = req.params as { slug: string; boardId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = AddBoardColumnRequest.parse(req.body);
      const row = await lockBoard(tx, team.id, boardId);
      const columns = columnsOf(row);
      if (columns.length >= MAX_BOARD_COLUMNS) throw conflict(`A board holds at most ${MAX_BOARD_COLUMNS} columns`);
      let id = newColumnId();
      while (columns.some((c) => c.id === id)) id = newColumnId();
      columns.push({ id, name: body.name, state: body.state, title: body.name });
      const saved = await saveColumns(ctx, tx, row, columns, 'column_added');
      return json(BoardColumnsResponse.parse({ board: toBoard(saved) }), 201);
    }),
  });

  ctx.http.route({
    ...renameBoardColumnRoute,
    schema: { body: RenameBoardColumnRequest, response: BoardColumnsResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId, columnId } = req.params as { slug: string; boardId: string; columnId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = RenameBoardColumnRequest.parse(req.body);
      const row = await lockBoard(tx, team.id, boardId);
      const columns = columnsOf(row);
      const col = columns.find((c) => c.id === columnId);
      if (!col) throw notFound('No such column');
      col.name = body.name;
      col.title = body.name;
      const saved = await saveColumns(ctx, tx, row, columns, 'column_renamed');
      return json(BoardColumnsResponse.parse({ board: toBoard(saved) }));
    }),
  });

  ctx.http.route({
    ...deleteBoardColumnRoute,
    schema: { response: BoardColumnsResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId, columnId } = req.params as { slug: string; boardId: string; columnId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const row = await lockBoard(tx, team.id, boardId);
      const columns = columnsOf(row);
      const col = columns.find((c) => c.id === columnId);
      if (!col) throw notFound('No such column');
      if (columns.length <= 1) throw conflict('A board keeps at least one column');
      // No place rows are left to clean: a column is deleted only when it holds no card, and a place row that no longer matches its card's state is
      // already dropped by the trigger. A row for a deleted column id would be ignored by every read anyway.
      const held = (await countColumns(tx, row)).get(columnId) ?? 0;
      if (held > 0) throw conflict(`${held === 1 ? '1 card is' : `${held} cards are`} in ${col.name}; move ${held === 1 ? 'it' : 'them'} first`);
      const saved = await saveColumns(ctx, tx, row, columns.filter((c) => c.id !== columnId), 'column_deleted');
      return json(BoardColumnsResponse.parse({ board: toBoard(saved) }));
    }),
  });

  // A compare-and-set: the new order must hold exactly the columns the board has now, so a tab that missed another tab's add or delete is told so
  // (409) instead of overwriting the other tab's change.
  ctx.http.route({
    ...reorderBoardColumnsRoute,
    schema: { body: ReorderBoardColumnsRequest, response: BoardColumnsResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId } = req.params as { slug: string; boardId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = ReorderBoardColumnsRequest.parse(req.body);
      const row = await lockBoard(tx, team.id, boardId);
      const columns = columnsOf(row);
      const same = body.columnIds.length === columns.length && new Set(body.columnIds).size === columns.length && body.columnIds.every((id) => columns.some((c) => c.id === id));
      if (!same) throw conflict('The columns changed in another tab; reload the board');
      const ordered = body.columnIds.map((id) => columns.find((c) => c.id === id)!);
      const saved = await saveColumns(ctx, tx, row, ordered, 'columns_reordered');
      return json(BoardColumnsResponse.parse({ board: toBoard(saved) }));
    }),
  });

  ctx.http.route({
    ...boardPlacesRoute,
    readOnly: true,
    schema: { response: BoardPlacesResponse },
    handler: route(async (req, tx) => {
      const { slug, boardId } = req.params as { slug: string; boardId: string };
      const team = await requireTeam(tx, slug);
      const row = (await tx.query<BoardRow>('SELECT * FROM app.boards WHERE id = $1::uuid AND team_id = $2::uuid', [boardId, team.id])).rows[0];
      if (!row) throw notFound('No such board');
      const ids = new Set(columnsOf(row).map((c) => c.id));
      const places = (
        await tx.query<{ task_id: string; column_id: string }>(
          `SELECT p.task_id, p.column_id FROM app.board_card_places p JOIN app.tasks t ON t.id = p.task_id AND t.state = p.state
            WHERE p.board_id = $1::uuid ORDER BY p.placed_at DESC LIMIT ${COUNT_CAP}`,
          [row.id],
        )
      ).rows.filter((p) => ids.has(p.column_id));
      const counts = await countColumns(tx, row);
      return json(
        BoardPlacesResponse.parse({
          places: places.map((p) => ({ taskId: p.task_id, columnId: p.column_id })),
          counts: [...ids].map((columnId) => ({ columnId, total: counts.get(columnId) ?? 0 })),
        }),
      );
    }),
  });
}
