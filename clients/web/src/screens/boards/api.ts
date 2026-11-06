import {
  AddBoardColumnRequest,
  BoardColumnsResponse,
  BoardPlacesResponse,
  CardActivityResponse,
  RenameBoardColumnRequest,
  ReorderBoardColumnsRequest,
  addBoardColumnRoute,
  boardPlacesRoute,
  cardActivityRoute,
  deleteBoardColumnRoute,
  renameBoardColumnRoute,
  reorderBoardColumnsRoute,
  ClaimTaskResponse,
  CompleteTaskRequest,
  CompleteTaskResponse,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateScheduledJobRequest,
  CreateScheduledJobResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  GetBoardResponse,
  GetTaskResponse,
  HandoffTaskRequest,
  HandoffTaskResponse,
  ListBoardsResponse,
  ListChannelBoardsResponse,
  ListScheduledJobRunsResponse,
  ListScheduledJobsResponse,
  ListTaskEventsResponse,
  ListTasksQuery,
  ListTasksResponse,
  MoveTaskRequest,
  MoveTaskResponse,
  ReleaseTaskResponse,
  ReworkTaskRequest,
  ReworkTaskResponse,
  RunScheduledJobResponse,
  UpdateScheduledJobRequest,
  UpdateScheduledJobResponse,
  claimTaskRoute,
  completeTaskRoute,
  createBoardRoute,
  createScheduledJobRoute,
  createTaskRoute,
  getBoardRoute,
  getTaskRoute,
  handoffTaskRoute,
  listBoardsRoute,
  listChannelBoardsRoute,
  listScheduledJobRunsRoute,
  listScheduledJobsRoute,
  listTaskEventsRoute,
  listTasksRoute,
  moveTaskRoute,
  releaseTaskRoute,
  reworkTaskRoute,
  TickTaskRequest,
  TickTaskResponse,
  tickTaskRoute,
  runScheduledJobRoute,
  updateScheduledJobRoute,
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

/** The drag: a column id puts the card in that column (its state decides the move); the task rules decide whether the card may go there. */
export const moveTask = (slug: string, boardId: string, taskId: string, columnId: string) =>
  call(moveTaskRoute, { request: MoveTaskRequest, response: MoveTaskResponse }, { taskId: taskId as MoveTaskRequest['taskId'], columnId }, { slug, boardId });

/** Where the cards sit among a board's columns, and how many cards each column holds. */
export const fetchPlaces = (slug: string, boardId: string) => call(boardPlacesRoute, { response: BoardPlacesResponse }, undefined, { slug, boardId });

/** The column edits (a team lead or a workspace admin). Each answers the whole board. */
export const addColumn = (slug: string, boardId: string, body: AddBoardColumnRequest) =>
  call(addBoardColumnRoute, { request: AddBoardColumnRequest, response: BoardColumnsResponse }, body, { slug, boardId });
export const renameColumn = (slug: string, boardId: string, columnId: string, body: RenameBoardColumnRequest) =>
  call(renameBoardColumnRoute, { request: RenameBoardColumnRequest, response: BoardColumnsResponse }, body, { slug, boardId, columnId });
export const deleteColumn = (slug: string, boardId: string, columnId: string) =>
  call(deleteBoardColumnRoute, { response: BoardColumnsResponse }, undefined, { slug, boardId, columnId });
export const reorderColumns = (slug: string, boardId: string, columnIds: string[]) =>
  call(reorderBoardColumnsRoute, { request: ReorderBoardColumnsRequest, response: BoardColumnsResponse }, { columnIds }, { slug, boardId });

/** Which bots work on which cards of the team (the bot icon on a card). */
export const fetchCardActivity = (slug: string) => call(cardActivityRoute, { response: CardActivityResponse }, undefined, { slug });

export const claimTask = (slug: string, taskId: string) =>
  call(claimTaskRoute, { response: ClaimTaskResponse }, undefined, { slug, taskId });

export const releaseTask = (slug: string, taskId: string) =>
  call(releaseTaskRoute, { response: ReleaseTaskResponse }, undefined, { slug, taskId });

export const completeTask = (slug: string, taskId: string, body: CompleteTaskRequest) =>
  call(completeTaskRoute, { request: CompleteTaskRequest, response: CompleteTaskResponse }, body, { slug, taskId });

export const reworkTask = (slug: string, taskId: string, body: ReworkTaskRequest) =>
  call(reworkTaskRoute, { request: ReworkTaskRequest, response: ReworkTaskResponse }, body, { slug, taskId });

/** Tick or untick one box of a card's description checklist: the server changes that one character and adds a line to the card's history. */
export const tickTask = (slug: string, taskId: string, body: TickTaskRequest) =>
  call(tickTaskRoute, { request: TickTaskRequest, response: TickTaskResponse }, body, { slug, taskId });

export const handoffTask = (slug: string, taskId: string, body: HandoffTaskRequest) =>
  call(handoffTaskRoute, { request: HandoffTaskRequest, response: HandoffTaskResponse }, body, { slug, taskId });

// ---- scheduled jobs (the board's third tab, SPEC §6.5) ------------------------------------------------------------

export const fetchScheduledJobs = (slug: string) => call(listScheduledJobsRoute, { response: ListScheduledJobsResponse }, undefined, { slug });

export const createScheduledJob = (slug: string, body: CreateScheduledJobRequest) =>
  call(createScheduledJobRoute, { request: CreateScheduledJobRequest, response: CreateScheduledJobResponse }, body, { slug });

export const updateScheduledJob = (slug: string, scheduledJobId: string, body: UpdateScheduledJobRequest) =>
  call(updateScheduledJobRoute, { request: UpdateScheduledJobRequest, response: UpdateScheduledJobResponse }, body, { slug, scheduledJobId });

export const fetchScheduledJobRuns = (slug: string, scheduledJobId: string) =>
  call(listScheduledJobRunsRoute, { response: ListScheduledJobRunsResponse }, undefined, { slug, scheduledJobId });

/** "Run now": the same path a tick takes, so a contract that would fail at 09:00 fails here too. */
export const runScheduledJob = (slug: string, scheduledJobId: string) =>
  call(runScheduledJobRoute, { response: RunScheduledJobResponse }, undefined, { slug, scheduledJobId });
