import { json, route, type MessageProvider, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import {
  GetThreadTodoResponse,
  TasksTaskCompletedEvent,
  TasksTaskHandedOffEvent,
  ThreadTodo,
  ThreadTodoPathParams,
  TodoChangedPush,
  TodoItem,
  TodoToolInput,
  WS_TODO_CHANGED,
  getThreadTodoRoute,
  type TodoStatus,
} from '@manythreads/shared';

/*
 * `tasks.todo` (PLAN P25-10, docs/plans/acp.md section 4.5): the one to-do list of a thread, kept by the bot that works the request. A default capability, like
 * `approvals.ask`: every bot has it with no BOT.md line.
 *
 *   { action: "set", title?, items: [{ id, text, status, taskId? }] }   make or replace the list (1 to 30 items, 200 characters each)
 *   { action: "update", id, status }                                    change one item
 *
 * The list is the row `app.thread_todos` (one per thread). The first `set` posts ONE message in the thread that carries `meta.todoRef` (the way a surface's message
 * carries `meta.surfaceRef`), with `skipRefs` so it wakes nobody; every later change is the row (and, when the title changed, an edit of that same message) and a
 * `todo.changed` push to everyone who can read the thread. Nothing else is ever posted for it. An item with a `taskId` follows its card: a handover sets it working with
 * the card's owner, a finished card ticks it (the two subscribers at the end). Only the bot that made the list changes it; a person cannot tick it.
 * The thread and the run come from the database (`app.todo_run_context`), never from an argument. The text is passed through the pre-egress chain (the secret redaction)
 * before it is kept, because everyone who reads the thread reads it.
 */

export const TODO_TOOL = 'tasks.todo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BODY = 'To-do list';

type Refusal = { ok: false; code: string; message: string };
const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });

type Context = {
  o_workspace_id: string;
  o_team_id: string | null;
  o_channel_id: string;
  o_root_id: string;
  o_actor_id: string;
};

type TodoRow = {
  thread_root_id: string;
  channel_id: string;
  message_id: string | null;
  bot_actor_id: string;
  title: string;
  items: unknown;
  version: number;
  updated_at: Date;
};

const COLUMNS = 'thread_root_id, channel_id, message_id, bot_actor_id, title, items, version, updated_at';

/** The list as the API shows it. An item that does not read (a newer shape) is dropped, never the list. */
export function todoOf(row: TodoRow): ThreadTodo {
  const items = (Array.isArray(row.items) ? row.items : []).flatMap((raw) => {
    const parsed = TodoItem.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  return ThreadTodo.parse({
    rootId: row.thread_root_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    botActorId: row.bot_actor_id,
    title: row.title,
    items,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  });
}

const issues = (e: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string =>
  e.issues
    .slice(0, 4)
    .map((i) => `${i.path.map(String).join('.') || '(arguments)'}: ${i.message}`)
    .join('; ');

/** Text everyone in the thread will read: through the secret redaction. A text that cannot be checked is not kept as it is. */
async function clean(ctx: PluginContext, tx: PluginTx, workspaceId: string, text: string, max: number): Promise<string> {
  if (text === '') return text;
  const chain = await ctx.hooks.runPreEgress(tx, { destination: 'approval', workspaceId, text, preset: 'standard' });
  const safe = chain.ran.includes('guardrails-dlp') && chain.outcome !== 'block' ? chain.text : '[not shown: it could not be checked for secrets]';
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

/** Tell everyone who can read the thread to read the list again. Sent in the change's own transaction, so a viewer hears only of a change that was kept. */
async function pushChanged(ctx: PluginContext, tx: PluginTx, channelId: string, rootId: string, version: number): Promise<void> {
  const people = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [channelId])).rows.map((r) => r.person_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, WS_TODO_CHANGED, TodoChangedPush.parse({ channelId, rootId, version }));
}

const counts = (items: readonly { status: TodoStatus }[]): Record<TodoStatus, number> => {
  const out: Record<TodoStatus, number> = { waiting: 0, working: 0, done: 0, blocked: 0 };
  for (const i of items) out[i.status] += 1;
  return out;
};

const NO_THREAD = 'The to-do list belongs to the thread you were asked in. Use it only while you answer a message in a channel or a conversation.';
const NOT_YOURS = 'This thread already has a to-do list that another bot keeps. Only that bot changes it.';

async function setList(ctx: PluginContext, tx: PluginTx, input: Extract<TodoToolInput, { action: 'set' }>): Promise<Record<string, unknown>> {
  const here = (await tx.query<Context>('SELECT * FROM app.todo_run_context()')).rows[0];
  if (!here) return refuse('no_thread', NO_THREAD);
  const ids = input.items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) return refuse('invalid_input', 'items: every item needs its own id; two items have the same one.');

  // The cards the items follow: they must be cards the bot can read. An item whose card is finished is done; its owner is the card's owner.
  const taskIds = [...new Set(input.items.flatMap((i) => (i.taskId ? [i.taskId] : [])))];
  const cards = new Map<string, { state: string; owner_id: string | null }>();
  if (taskIds.length > 0) {
    const found = await tx.query<{ id: string; state: string; owner_id: string | null }>(
      "SELECT t.id, t.state, t.owner_id FROM app.tasks t WHERE t.id = ANY ($1::uuid[]) AND t.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])",
      [taskIds],
    );
    for (const c of found.rows) cards.set(c.id, c);
    const missing = taskIds.find((id) => !cards.has(id));
    if (missing) return refuse('invalid_input', `items: taskId ${missing} is not a card you can read.`);
  }

  const existing = (await tx.query<{ message_id: string | null; bot_actor_id: string; title: string }>('SELECT message_id, bot_actor_id, title FROM app.thread_todos WHERE thread_root_id = $1::uuid', [here.o_root_id])).rows[0];
  if (existing && existing.bot_actor_id !== here.o_actor_id) return refuse('not_owner', NOT_YOURS);

  const title = await clean(ctx, tx, here.o_workspace_id, input.title ?? '', 120);
  const items: Array<{ id: string; text: string; status: TodoStatus; taskId?: string; ownerId?: string }> = [];
  for (const i of input.items) {
    const card = i.taskId ? cards.get(i.taskId) : undefined;
    const status: TodoStatus = card?.state === 'done' ? 'done' : i.status;
    items.push({
      id: i.id,
      text: await clean(ctx, tx, here.o_workspace_id, i.text, 200),
      status,
      ...(i.taskId ? { taskId: i.taskId } : {}),
      ...(card?.owner_id ? { ownerId: card.owner_id } : {}),
    });
  }

  // The one message of the list: posted by the first `set`, and kept (edited only when the title changed) by the next ones. A deleted message is posted again.
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return refuse('unavailable', 'Messages are not available in this deployment.');
  const body = title === '' ? DEFAULT_BODY : title;
  let messageId: string | null = null;
  let posted = false;
  if (existing?.message_id) {
    const alive = (await tx.query('SELECT 1 FROM app.messages WHERE id = $1::uuid AND deleted_at IS NULL', [existing.message_id])).rows.length > 0;
    if (alive) messageId = existing.message_id;
  }
  try {
    if (messageId === null) {
      messageId = (await messages.post(tx, { channelId: here.o_channel_id, body, threadRootId: here.o_root_id, meta: { todoRef: here.o_root_id }, skipRefs: true })).id;
      posted = true;
    } else if ((existing?.title ?? '') !== title) {
      await messages.edit(tx, { channelId: here.o_channel_id, messageId, body });
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) return refuse('forbidden', 'You cannot post in this channel, so you cannot keep a list in it.');
    throw err;
  }

  const saved = (
    await tx.query<{ o_outcome: string; o_channel_id: string | null; o_root_id: string | null; o_version: number | null }>(
      'SELECT o_outcome, o_channel_id, o_root_id, o_version FROM app.todo_write($1, $2::jsonb, $3::uuid)',
      [title, JSON.stringify(items), messageId],
    )
  ).rows[0];
  if (saved?.o_outcome !== 'saved' || saved.o_version === null || saved.o_channel_id === null || saved.o_root_id === null) {
    // Something the checks above could not see (another call changed the list in between). The message just posted must not stay behind, so the call fails whole.
    if (posted) throw new Error(`tasks.todo: the list was not saved (${saved?.o_outcome ?? 'no answer'})`);
    return refuse(saved?.o_outcome ?? 'conflict', saved?.o_outcome === 'not_owner' ? NOT_YOURS : 'The list could not be saved. Read it again and try once more.');
  }
  await pushChanged(ctx, tx, saved.o_channel_id, saved.o_root_id, saved.o_version);
  return {
    ok: true,
    version: saved.o_version,
    counts: counts(items),
    message: posted ? 'The list is posted in the thread. Change one item with action "update"; send "set" again to replace the whole list.' : 'The list in the thread is updated.',
  };
}

async function updateItem(ctx: PluginContext, tx: PluginTx, input: Extract<TodoToolInput, { action: 'update' }>): Promise<Record<string, unknown>> {
  const out = (
    await tx.query<{ o_outcome: string; o_channel_id: string | null; o_root_id: string | null; o_version: number | null }>(
      'SELECT o_outcome, o_channel_id, o_root_id, o_version FROM app.todo_set_status($1, $2)',
      [input.id, input.status],
    )
  ).rows[0];
  switch (out?.o_outcome) {
    case 'saved':
      if (out.o_channel_id === null || out.o_root_id === null || out.o_version === null) return refuse('conflict', 'The list could not be saved.');
      await pushChanged(ctx, tx, out.o_channel_id, out.o_root_id, out.o_version);
      return { ok: true, version: out.o_version, id: input.id, status: input.status };
    case 'no_run':
      return refuse('no_thread', NO_THREAD);
    case 'no_list':
      return refuse('no_list', 'This thread has no to-do list yet. Make one with action "set".');
    case 'not_owner':
      return refuse('not_owner', NOT_YOURS);
    case 'no_item':
      return refuse('no_item', `The list has no item with the id "${input.id}". Send "set" with the whole list to add one.`);
    default:
      return refuse('invalid_input', 'status: waiting, working, done or blocked.');
  }
}

/** The items that name a card follow it. Idempotent: an item already in the state asked for is left alone, so a delivery that comes twice changes nothing. */
async function follow(ctx: PluginContext, tx: PluginTx, workspaceId: string, taskId: string, status: TodoStatus, ownerId: string | null): Promise<void> {
  if (!UUID.test(taskId)) return;
  const rows = (
    await tx.query<TodoRow>(`SELECT ${COLUMNS} FROM app.thread_todos WHERE workspace_id = $1::uuid AND items @> $2::jsonb FOR UPDATE`, [workspaceId, JSON.stringify([{ taskId }])])
  ).rows;
  for (const row of rows) {
    const list = Array.isArray(row.items) ? (row.items as Array<Record<string, unknown>>) : [];
    let changed = false;
    const next = list.map((item) => {
      if (item['taskId'] !== taskId) return item;
      // a handover never undoes a finished item
      if (status === 'working' && item['status'] === 'done') return item;
      const owner = ownerId ?? (typeof item['ownerId'] === 'string' ? item['ownerId'] : null);
      if (item['status'] === status && (item['ownerId'] ?? null) === owner) return item;
      changed = true;
      return { ...item, status, ...(owner ? { ownerId: owner } : {}) };
    });
    if (!changed) continue;
    const updated = (
      await tx.query<{ version: number }>('UPDATE app.thread_todos SET items = $2::jsonb, version = version + 1, updated_at = now() WHERE thread_root_id = $1::uuid RETURNING version', [
        row.thread_root_id,
        JSON.stringify(next),
      ])
    ).rows[0];
    if (updated) await pushChanged(ctx, tx, row.channel_id, row.thread_root_id, updated.version);
  }
}

export function registerTodo(ctx: PluginContext): void {
  ctx.capabilities.register(TODO_TOOL, async (raw, tx) => {
    const parsed = TodoToolInput.safeParse(raw);
    if (!parsed.success) return refuse('invalid_input', issues(parsed.error));
    return parsed.data.action === 'set' ? setList(ctx, tx, parsed.data) : updateItem(ctx, tx, parsed.data);
  });

  // GET /api/threads/:rootId/todo: read as the caller, so the rule is the table's (whoever can read the thread's channel). A thread with no list and a thread the caller
  // cannot read answer the same way.
  ctx.http.route({
    ...getThreadTodoRoute,
    readOnly: true,
    schema: { response: GetThreadTodoResponse },
    handler: route(async (req, tx) => {
      const { rootId } = ThreadTodoPathParams.parse(req.params);
      const row = (await tx.query<TodoRow>(`SELECT ${COLUMNS} FROM app.thread_todos WHERE thread_root_id = $1::uuid`, [rootId])).rows[0];
      return json(GetThreadTodoResponse.parse({ todo: row ? todoOf(row) : null }));
    }),
  });

  // The items that follow a card, set by the platform: a handover sets them working with the card's new owner, a finished card ticks them.
  ctx.events.subscribe('tasks.task.handed_off', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TasksTaskHandedOffEvent.parse(raw);
    await follow(ctx, tx, event.workspaceId, event.taskId, 'working', event.toActorId);
  });
  ctx.events.subscribe('tasks.task.completed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TasksTaskCompletedEvent.parse(raw);
    await follow(ctx, tx, event.workspaceId, event.taskId, 'done', null);
  });
}
