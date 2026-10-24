import { z } from 'zod';
import { Board, BoardColumn, Task, TaskState } from '../../entities/task.ts';
import { BoardId, TaskId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListBoardsPathParams = z.object({ slug: TeamSlug });
export type ListBoardsPathParams = z.infer<typeof ListBoardsPathParams>;

export const ListBoardsResponse = z.object({ items: z.array(Board) });
export type ListBoardsResponse = z.infer<typeof ListBoardsResponse>;
export const listBoardsRoute = { method: 'GET', path: '/api/teams/:slug/boards' } as const;

/** A board's columns are a subset of the five states, each at most once; omitted means the five in pipeline order. */
export const CreateBoardRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    columns: z.array(BoardColumn).min(1).max(5).optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of (v.columns ?? []).entries()) {
      if (seen.has(c.state)) ctx.addIssue({ code: 'custom', path: ['columns', i], message: `duplicate column ${c.state}` });
      seen.add(c.state);
    }
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
export const MoveTaskRequest = z.strictObject({ taskId: TaskId, to: TaskState });
export type MoveTaskRequest = z.infer<typeof MoveTaskRequest>;
export const MoveTaskResponse = z.object({ task: Task });
export type MoveTaskResponse = z.infer<typeof MoveTaskResponse>;
export const moveTaskRoute = { method: 'POST', path: '/api/teams/:slug/boards/:boardId/move' } as const;
