import {
  ClaimTaskResponse,
  CompleteTaskRequest,
  CompleteTaskResponse,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateRhythmRequest,
  CreateRhythmResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  GetBoardResponse,
  GetTaskResponse,
  HandoffTaskRequest,
  HandoffTaskResponse,
  ListBoardsResponse,
  ListChannelBoardsResponse,
  ListRhythmRunsResponse,
  ListRhythmsResponse,
  ListTaskEventsResponse,
  ListTasksQuery,
  ListTasksResponse,
  MoveTaskRequest,
  MoveTaskResponse,
  ReleaseTaskResponse,
  ReworkTaskRequest,
  ReworkTaskResponse,
  RunRhythmResponse,
  UpdateRhythmRequest,
  UpdateRhythmResponse,
  claimTaskRoute,
  completeTaskRoute,
  createBoardRoute,
  createRhythmRoute,
  createTaskRoute,
  getBoardRoute,
  getTaskRoute,
  handoffTaskRoute,
  listBoardsRoute,
  listChannelBoardsRoute,
  listRhythmRunsRoute,
  listRhythmsRoute,
  listTaskEventsRoute,
  listTasksRoute,
  moveTaskRoute,
  releaseTaskRoute,
  reworkTaskRoute,
  runRhythmRoute,
  updateRhythmRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Boards screen asks of the server (PLAN P6-07/P6-08). A board is a saved view over the task substrate, so every move the
 * screen makes is a task call: a drag is `POST /boards/:boardId/move`, and claim, complete, rework and handoff are the card routes. The
 * screen never writes a state with its own rules — the reason a move was refused is the server's own sentence, shown as it arrives.
 */

export type Json = Record<string, unknown>;

export const fetchBoards = (slug: string) => call(listBoardsRoute, { response: ListBoardsResponse }, undefined, { slug });

/** The boards attached to one channel (the header's Bot Board link). */
export const fetchChannelBoards = (channelId: string) =>
  call(listChannelBoardsRoute, { response: ListChannelBoardsResponse }, undefined, { channelId });

/** A board and its columns; a column's cards are one filtered task read (`state` + the board's saved filter). */
export const fetchBoard = (slug: string, boardId: string) =>
  call(getBoardRoute, { response: GetBoardResponse }, undefined, { slug, boardId });

export const createBoard = (slug: string, body: CreateBoardRequest) =>
  call(createBoardRoute, { request: CreateBoardRequest, response: CreateBoardResponse }, body, { slug });

/**
 * One column's cards. `limit` is the server's maximum (100): a column with more says how many it has (`total`) and offers no more than
 * the newest hundred, which is what the board can draw anyway.
 */
export const fetchColumnTasks = (slug: string, query: Partial<ListTasksQuery> = {}) => {
  const parsed = ListTasksQuery.parse({ limit: 100, ...query });
  return call(listTasksRoute, { request: ListTasksQuery, response: ListTasksResponse }, parsed, { slug });
};

export const fetchTask = (slug: string, taskId: string) => call(getTaskRoute, { response: GetTaskResponse }, undefined, { slug, taskId });

export const fetchTaskEvents = (slug: string, taskId: string) =>
  call(listTaskEventsRoute, { response: ListTaskEventsResponse }, undefined, { slug, taskId });

export const createTask = (slug: string, body: CreateTaskRequest) =>
  call(createTaskRoute, { request: CreateTaskRequest, response: CreateTaskResponse }, body, { slug });

/** The drag: the board decides which states it has, the task rules decide whether the card may go there. */
export const moveTask = (slug: string, boardId: string, taskId: string, to: MoveTaskRequest['to']) =>
  call(moveTaskRoute, { request: MoveTaskRequest, response: MoveTaskResponse }, { taskId, to }, { slug, boardId });

export const claimTask = (slug: string, taskId: string) =>
  call(claimTaskRoute, { response: ClaimTaskResponse }, undefined, { slug, taskId });

export const releaseTask = (slug: string, taskId: string) =>
  call(releaseTaskRoute, { response: ReleaseTaskResponse }, undefined, { slug, taskId });

export const completeTask = (slug: string, taskId: string, body: CompleteTaskRequest) =>
  call(completeTaskRoute, { request: CompleteTaskRequest, response: CompleteTaskResponse }, body, { slug, taskId });

export const reworkTask = (slug: string, taskId: string, body: ReworkTaskRequest) =>
  call(reworkTaskRoute, { request: ReworkTaskRequest, response: ReworkTaskResponse }, body, { slug, taskId });

export const handoffTask = (slug: string, taskId: string, body: HandoffTaskRequest) =>
  call(handoffTaskRoute, { request: HandoffTaskRequest, response: HandoffTaskResponse }, body, { slug, taskId });

// ---- rhythms (the board's third tab, SPEC §6.5) ------------------------------------------------------------

export const fetchRhythms = (slug: string) => call(listRhythmsRoute, { response: ListRhythmsResponse }, undefined, { slug });

export const createRhythm = (slug: string, body: CreateRhythmRequest) =>
  call(createRhythmRoute, { request: CreateRhythmRequest, response: CreateRhythmResponse }, body, { slug });

export const updateRhythm = (slug: string, rhythmId: string, body: UpdateRhythmRequest) =>
  call(updateRhythmRoute, { request: UpdateRhythmRequest, response: UpdateRhythmResponse }, body, { slug, rhythmId });

export const fetchRhythmRuns = (slug: string, rhythmId: string) =>
  call(listRhythmRunsRoute, { response: ListRhythmRunsResponse }, undefined, { slug, rhythmId });

/** "Run now": the same path a tick takes, so a contract that would fail at 09:00 fails here too. */
export const runRhythm = (slug: string, rhythmId: string) =>
  call(runRhythmRoute, { response: RunRhythmResponse }, undefined, { slug, rhythmId });
