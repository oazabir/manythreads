import { z } from 'zod';
import { Board, BoardColumnId, MAX_BOARD_COLUMNS, Task, TaskState } from '../../entities/task.ts';
import { BoardId, ChannelId, TaskId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListBoardsPathParams = z.object({ slug: TeamSlug });
export type ListBoardsPathParams = z.infer<typeof ListBoardsPathParams>;

export const ListBoardsResponse = z.object({ items: z.array(Board) });
export type ListBoardsResponse = z.infer<typeof ListBoardsResponse>;
export const listBoardsRoute = { method: 'GET', path: '/api/teams/:slug/boards' } as const;

/** One column to create: a name and the task state it counts as. The server makes the id. Two columns may count as the same state. */
export const NewBoardColumn = z.strictObject({ name: z.string().trim().min(1).max(60), state: TaskState });
export type NewBoardColumn = z.infer<typeof NewBoardColumn>;

/** Omitted columns means the five states in pipeline order. */
export const CreateBoardRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  columns: z.array(NewBoardColumn).min(1).max(MAX_BOARD_COLUMNS).optional(),
});
export type CreateBoardRequest = z.infer<typeof CreateBoardRequest>;
export const CreateBoardResponse = z.object({ board: Board });
export type CreateBoardResponse = z.infer<typeof CreateBoardResponse>;
export const createBoardRoute = { method: 'POST', path: '/api/teams/:slug/boards' } as const;

export const BoardPathParams = z.object({ slug: TeamSlug, boardId: BoardId });
export type BoardPathParams = z.infer<typeof BoardPathParams>;
export const GetBoardResponse = z.object({ board: Board });
export type GetBoardResponse = z.infer<typeof GetBoardResponse>;
export const getBoardRoute = { method: 'GET', path: '/api/teams/:slug/boards/:boardId' } as const;

/**
 * A drag. The move runs through the same rules as a tool call: the transition table, and a `code` card cannot enter `done` without its
 * tested sha. A refused move answers 409 with the reason, and nothing changes.
 */
export const MoveTaskRequest = z
  .strictObject({
    taskId: TaskId,
    /** Move to the first column of this state (what a client without custom columns sends). */
    to: TaskState.optional(),
    /** Move to this column of the board; its state decides the card's state. */
    columnId: BoardColumnId.optional(),
  })
  .refine((v) => v.to !== undefined || v.columnId !== undefined, { message: 'name a state (to) or a column (columnId)' });
export type MoveTaskRequest = z.infer<typeof MoveTaskRequest>;
export const MoveTaskResponse = z.object({ task: Task });
export type MoveTaskResponse = z.infer<typeof MoveTaskResponse>;
export const moveTaskRoute = { method: 'POST', path: '/api/teams/:slug/boards/:boardId/move' } as const;

/** The boards attached to a channel the caller can read (a channel they cannot read answers an empty list, which says no more than a channel with no boards). */
export const ListChannelBoardsPathParams = z.object({ channelId: ChannelId });
export type ListChannelBoardsPathParams = z.infer<typeof ListChannelBoardsPathParams>;
export const ListChannelBoardsResponse = z.object({ items: z.array(Board) });
export type ListChannelBoardsResponse = z.infer<typeof ListChannelBoardsResponse>;
export const listChannelBoardsRoute = { method: 'GET', path: '/api/channels/:channelId/boards' } as const;

/** The board's column edits. Each answers the whole board; only a team lead or a workspace admin may make them. */
export const AddBoardColumnRequest = NewBoardColumn;
export type AddBoardColumnRequest = z.infer<typeof AddBoardColumnRequest>;
export const addBoardColumnRoute = { method: 'POST', path: '/api/teams/:slug/boards/:boardId/columns' } as const;

export const BoardColumnPathParams = z.object({ slug: TeamSlug, boardId: BoardId, columnId: BoardColumnId });
export type BoardColumnPathParams = z.infer<typeof BoardColumnPathParams>;
export const RenameBoardColumnRequest = z.strictObject({ name: z.string().trim().min(1).max(60) });
export type RenameBoardColumnRequest = z.infer<typeof RenameBoardColumnRequest>;
export const renameBoardColumnRoute = { method: 'PATCH', path: '/api/teams/:slug/boards/:boardId/columns/:columnId' } as const;
/** Refused (409) while the column holds cards, and for the last column of a board. */
export const deleteBoardColumnRoute = { method: 'DELETE', path: '/api/teams/:slug/boards/:boardId/columns/:columnId' } as const;

/** The new order: exactly the board's current ids. A different set (another tab changed the columns) answers 409, and nothing changes. */
export const ReorderBoardColumnsRequest = z.strictObject({ columnIds: z.array(BoardColumnId).min(1).max(MAX_BOARD_COLUMNS) });
export type ReorderBoardColumnsRequest = z.infer<typeof ReorderBoardColumnsRequest>;
export const reorderBoardColumnsRoute = { method: 'PUT', path: '/api/teams/:slug/boards/:boardId/columns/order' } as const;

export const BoardColumnsResponse = z.object({ board: Board });
export type BoardColumnsResponse = z.infer<typeof BoardColumnsResponse>;

/**
 * Where cards sit on a board. A card in the first column of its state has no row, so `places` lists only cards placed in a later column of that
 * state. `counts` is the number of cards per column (the most recent 2000 cards of the board are counted).
 */
export const BoardPlacesResponse = z.object({
  places: z.array(z.strictObject({ taskId: TaskId, columnId: BoardColumnId })),
  counts: z.array(z.strictObject({ columnId: BoardColumnId, total: z.number().int().min(0) })),
});
export type BoardPlacesResponse = z.infer<typeof BoardPlacesResponse>;
export const boardPlacesRoute = { method: 'GET', path: '/api/teams/:slug/boards/:boardId/places' } as const;
