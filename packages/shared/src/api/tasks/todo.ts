import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, MessageId, TaskId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// The to-do list of a thread (PLAN P25-10, docs/plans/acp.md section 4.5). One list per thread, kept by the bot that works the request: a title and at most thirty
// items, each waiting, working, done or blocked. It is not the agent's plan of one run (that is `run_view.plan`) and not the team's board. An item may name a card
// (`taskId`); it then follows the card by itself (a handover sets it working with the card's owner, a finished card ticks it). Whoever can read the thread reads the
// list; the bot that made it replaces it (another bot may, when the owner has no live run in the thread), any bot with a live run in the thread may change one item's
// status, and a person cannot tick it.

export const TODO_MAX_ITEMS = 30;
export const TODO_TEXT_MAX = 200;
export const TODO_TITLE_MAX = 120;
/** The most the items of one list may weigh as JSON (UTF-8 bytes): thirty items of 200 four-byte characters fit, a follower's owner ids still have room under the table's own check. */
export const TODO_ITEMS_MAX_BYTES = 32_000;

export const TodoStatus = z.enum(['waiting', 'working', 'done', 'blocked']);
export type TodoStatus = z.infer<typeof TodoStatus>;

/** The bot's own name for an item, stable across `set` calls so `update` can find it. */
export const TodoItemId = z.string().regex(/^[A-Za-z0-9_.:-]{1,40}$/, 'an id of 1 to 40 letters, digits and . _ : -');

/** What a bot sends for one item. */
export const TodoItemInput = z.strictObject({
  id: TodoItemId,
  text: z.string().trim().min(1).max(TODO_TEXT_MAX),
  status: TodoStatus,
  taskId: TaskId.optional(),
});
export type TodoItemInput = z.infer<typeof TodoItemInput>;

/** `tasks.todo` with `action: "set"`: make or replace the thread's list. */
export const TodoSetInput = z.strictObject({
  action: z.literal('set'),
  title: z.string().trim().max(TODO_TITLE_MAX).optional(),
  items: z.array(TodoItemInput).min(1).max(TODO_MAX_ITEMS),
});
/** `tasks.todo` with `action: "update"`: change the status of one item. */
export const TodoUpdateInput = z.strictObject({ action: z.literal('update'), id: TodoItemId, status: TodoStatus });
export const TodoToolInput = z.discriminatedUnion('action', [TodoSetInput, TodoUpdateInput]);
export type TodoToolInput = z.infer<typeof TodoToolInput>;

/** One item as it is kept and shown. `ownerId` is the owner of the card the item follows, set by the platform. */
export const TodoItem = z.object({
  id: TodoItemId,
  text: z.string().max(TODO_TEXT_MAX),
  status: TodoStatus,
  taskId: TaskId.optional(),
  ownerId: ActorId.optional(),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const ThreadTodo = z.object({
  /** The thread's root message. */
  rootId: MessageId,
  channelId: ChannelId,
  /** The message in the thread that carries the list (`meta.todoRef`); null when it was deleted and not yet posted again. */
  messageId: MessageId.nullable(),
  /** The bot that made the list. */
  botActorId: ActorId,
  title: z.string().max(TODO_TITLE_MAX),
  items: z.array(TodoItem).max(TODO_MAX_ITEMS),
  /** Goes up by one on every change; a client keeps the newer of two answers. */
  version: z.number().int().min(1),
  updatedAt: IsoDateTime,
});
export type ThreadTodo = z.infer<typeof ThreadTodo>;

export const ThreadTodoPathParams = z.object({ rootId: MessageId });
export type ThreadTodoPathParams = z.infer<typeof ThreadTodoPathParams>;
/** `todo` is null when the thread has no list, and also when the caller cannot read the thread: the two are not told apart. */
export const GetThreadTodoResponse = z.object({ todo: ThreadTodo.nullable() });
export type GetThreadTodoResponse = z.infer<typeof GetThreadTodoResponse>;
export const getThreadTodoRoute = { method: 'GET', path: '/api/threads/:rootId/todo' } as const satisfies ApiRoute;

/** The live push to everyone who can read the thread: the list changed, read it again. A hint only (a push is small): it carries the version, never the items. */
export const WS_TODO_CHANGED = 'todo.changed';
export const TodoChangedPush = z.object({ channelId: ChannelId, rootId: MessageId, version: z.number().int().min(1) });
export type TodoChangedPush = z.infer<typeof TodoChangedPush>;

/** The open lists of one channel, for the task view under its roots (P29): lists with an item not done that changed in the last `CHANNEL_TODO_FRESH_HOURS`, and lists finished in the last `CHANNEL_TODO_DONE_MINUTES`. */
export const CHANNEL_TODO_FRESH_HOURS = 24;
export const CHANNEL_TODO_DONE_MINUTES = 5;
export const CHANNEL_TODOS_MAX = 50;
export const ChannelTodosPathParams = z.object({ channelId: ChannelId });
export type ChannelTodosPathParams = z.infer<typeof ChannelTodosPathParams>;
export const ChannelTodosResponse = z.object({ todos: z.array(ThreadTodo).max(CHANNEL_TODOS_MAX) });
export type ChannelTodosResponse = z.infer<typeof ChannelTodosResponse>;
export const listChannelTodosRoute = { method: 'GET', path: '/api/channels/:channelId/todos' } as const satisfies ApiRoute;
/** The same read for the threads the Threads view lists (P29), by root (`ThreadBatchQuery`). */
export const listThreadBatchTodosRoute = { method: 'GET', path: '/api/thread-batch/todos' } as const satisfies ApiRoute;
