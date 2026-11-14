import { json, route, type MessageProvider, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import {
  GetThreadTodoResponse,
  TasksTaskCompletedEvent,
  TasksTaskHandedOffEvent,
  ThreadTodo,
  ThreadTodoPathParams,
  TodoChangedPush,
  TODO_ITEMS_MAX_BYTES,
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
 * the card's owner, a finished card ticks it (the two subscribers at the end). The bot that made the list replaces it, or another bot when the owner has no live run in the
 * thread; any bot with a live run in the thread may change one item's status; a person cannot tick it. Two calls of one thread go one at a time (an advisory lock).
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
  o_bot_id: string;
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

/**
 * At most `max` UTF-16 units (the unit the shared schema counts in, so what is kept can be read back whole), never cutting a character that is two units in half (the database
 * refuses a lone half). A text that is cut ends in an ellipsis.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// What separates the texts of one batch: the record separator, which is taken out of every text first so a bot cannot forge a boundary.
const SPLIT = '\n\u001e\n';
const NO_DLP = 'The data-loss check is not installed in this workspace, so a list that everyone in the thread reads cannot be kept here.';

/**
 * Text everyone in the thread will read goes through the secret redaction: ALL the texts of one call (the title and every item) in a single pre-egress call to the
 * `channel` destination, for this bot and team, so a call costs one scan and leaves one audit line. A text that cannot be checked is not kept: when no data-loss plugin is
 * installed the call is refused (as the other plugins do: the approvals preview, the terminal recorder and the MCP gateway withhold, never wave text through). If the
 * redaction folds two texts into one (a finding that spans the boundary), the texts are checked one by one instead.
 */
async function cleanAll(ctx: PluginContext, tx: PluginTx, here: Context, texts: readonly string[], max: readonly number[]): Promise<{ ok: true; texts: string[]; redacted: number } | Refusal> {
  const plain = texts.map((t) => t.replaceAll('\u001e', ' '));
  const ask = (text: string, recorded: boolean) =>
    ctx.hooks.runPreEgress(tx, { destination: 'channel', workspaceId: here.o_workspace_id, teamId: here.o_team_id, botId: here.o_bot_id, text, preset: 'standard', recorded });
  const refusal = (rules: readonly string[]): Refusal =>
    refuse('blocked', `The list holds something the workspace's data rules do not let into a thread${rules.length > 0 ? ` (${rules.join(', ')})` : ''}. Take it out and send the list again.`);

  let out: string[] = plain;
  if (plain.some((t) => t !== '')) {
    const batch = await ask(plain.join(SPLIT), false);
    if (!batch.ran.includes('guardrails-dlp')) return refuse('unavailable', NO_DLP);
    if (batch.outcome === 'block' || batch.outcome === 'require_approval') return refusal(batch.rules);
    if (batch.outcome === 'redact') {
      const parts = batch.text.split(SPLIT);
      if (parts.length === plain.length) out = parts;
      else {
        out = [];
        for (const t of plain) {
          if (t === '') {
            out.push(t);
            continue;
          }
          const one = await ask(t, true);
          if (!one.ran.includes('guardrails-dlp')) return refuse('unavailable', NO_DLP);
          if (one.outcome === 'block' || one.outcome === 'require_approval') return refusal(one.rules);
          out.push(one.outcome === 'redact' ? one.text : t);
        }
      }
    }
  }
  const redacted = out.filter((t, i) => t !== plain[i]).length;
  return { ok: true, texts: out.map((t, i) => clip(t, max[i] ?? 200)), redacted };
}

const PUSH_GAP_MS = 500;
const pushes = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();

async function sendPush(ctx: PluginContext, tx: PluginTx, channelId: string, rootId: string, version: number): Promise<void> {
  const people = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [channelId])).rows.map((r) => r.person_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, WS_TODO_CHANGED, TodoChangedPush.parse({ channelId, rootId, version }));
}

/**
 * Tell everyone who can read the thread to read the list again. The first change goes out in the change's own transaction, so a viewer hears only of a change that was kept.
 * A list changes many times a second when a bot ticks items in a loop, so one list is announced at most twice a second: a change inside the gap sends nothing now, and one later push
 * (its own transaction, the version the list has then) follows when the gap ends, so the last state is always announced.
 */
async function pushChanged(ctx: PluginContext, tx: PluginTx, workspaceId: string, channelId: string, rootId: string, version: number): Promise<void> {
  const now = Date.now();
  const state = pushes.get(rootId) ?? { last: 0, timer: null };
  pushes.set(rootId, state);
  if (pushes.size > 2000) for (const [key, value] of pushes) if (value.timer === null && now - value.last > 10_000) pushes.delete(key);
  if (now - state.last >= PUSH_GAP_MS) {
    state.last = now;
    await sendPush(ctx, tx, channelId, rootId, version);
    return;
  }
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.last = Date.now();
    void ctx.db
      .system(async (sys) => {
        const row = (await sys.query<{ version: number }>('SELECT version FROM app.thread_todos WHERE thread_root_id = $1::uuid', [rootId])).rows[0];
        if (row) await sendPush(ctx, sys, channelId, rootId, row.version);
      }, { workspaceId })
      .catch(() => undefined); // the push is a hint: the next read of the list is right anyway
  }, state.last + PUSH_GAP_MS - now + 20);
  state.timer.unref();
}

const counts = (items: readonly { status: TodoStatus }[]): Record<TodoStatus, number> => {
  const out: Record<TodoStatus, number> = { waiting: 0, working: 0, done: 0, blocked: 0 };
  for (const i of items) out[i.status] += 1;
  return out;
};

const NO_THREAD = 'The to-do list belongs to the thread you were asked in. Use it only while you answer a message in a channel or a conversation.';
const NOT_YOURS = 'This thread already has a to-do list that another bot keeps, and that bot is still working in the thread. Only it changes the whole list; you can change one item\'s status with action "update".';
const CANNOT_POST = 'You cannot post in this channel (any more), so you cannot change the list in it.';
const TOO_BIG = `The list is too large to keep (more than ${TODO_ITEMS_MAX_BYTES} bytes). Shorten the items or send fewer.`;

const canPost = async (tx: PluginTx, channelId: string): Promise<boolean> =>
  (await tx.query<{ ok: boolean }>("SELECT $1::uuid = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]) AS ok", [channelId])).rows[0]?.ok === true;

async function setList(ctx: PluginContext, tx: PluginTx, input: Extract<TodoToolInput, { action: 'set' }>): Promise<Record<string, unknown>> {
  const here = (await tx.query<Context>('SELECT * FROM app.todo_run_context()')).rows[0];
  if (!here) return refuse('no_thread', NO_THREAD);
  // One call of a thread at a time: two parallel sets would each see no list and post a card.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('todo:' || $1::text))", [here.o_root_id]);
  const ids = input.items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) return refuse('invalid_input', 'items: every item needs its own id; two items have the same one.');
  if (!(await canPost(tx, here.o_channel_id))) return refuse('forbidden', CANNOT_POST);

  // The cards the items follow: they must be cards of the thread's own team. An item whose card is finished is done; its owner is the card's owner.
  const taskIds = [...new Set(input.items.flatMap((i) => (i.taskId ? [i.taskId] : [])))];
  const cards = new Map<string, { state: string; owner_id: string | null }>();
  if (taskIds.length > 0) {
    const found =
      here.o_team_id === null
        ? { rows: [] as Array<{ id: string; state: string; owner_id: string | null }> }
        : await tx.query<{ id: string; state: string; owner_id: string | null }>('SELECT t.id, t.state, t.owner_id FROM app.tasks t WHERE t.id = ANY ($1::uuid[]) AND t.team_id = $2::uuid', [taskIds, here.o_team_id]);
    for (const c of found.rows) cards.set(c.id, c);
    const missing = taskIds.find((id) => !cards.has(id));
    if (missing) return refuse('invalid_input', `items: taskId ${missing} is not a card of this thread's team.`);
  }

  const existing = (await tx.query<{ message_id: string | null; bot_actor_id: string; title: string }>('SELECT message_id, bot_actor_id, title FROM app.thread_todos WHERE thread_root_id = $1::uuid', [here.o_root_id])).rows[0];
  const mine = existing === undefined || existing.bot_actor_id === here.o_actor_id;
  // Another bot's list is changed whole only when that bot has no live run in this thread any more; the list is then this bot's.
  if (!mine && (await tx.query<{ live: boolean }>('SELECT app.todo_bot_is_live($1::uuid, $2::uuid) AS live', [existing.bot_actor_id, here.o_root_id])).rows[0]?.live === true) return refuse('not_owner', NOT_YOURS);

  const cleaned = await cleanAll(ctx, tx, here, [input.title ?? '', ...input.items.map((i) => i.text)], [120, ...input.items.map(() => 200)]);
  if (!cleaned.ok) return cleaned;
  const title = cleaned.texts[0] ?? '';
  const items: Array<{ id: string; text: string; status: TodoStatus; taskId?: string; ownerId?: string }> = input.items.map((i, n) => {
    const card = i.taskId ? cards.get(i.taskId) : undefined;
    return {
      id: i.id,
      text: cleaned.texts[n + 1] ?? '',
      status: card?.state === 'done' ? 'done' : i.status,
      ...(i.taskId ? { taskId: i.taskId } : {}),
      ...(card?.owner_id ? { ownerId: card.owner_id } : {}),
    };
  });
  const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
  if (bytes > TODO_ITEMS_MAX_BYTES) return refuse('invalid_input', TOO_BIG);

  // The one message of the list: posted by the first `set`, and kept (edited only when the title changed) by the next ones. A deleted message is posted again, and so is
  // one that belongs to the bot this one took the list over from (a bot edits only its own message).
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return refuse('unavailable', 'Messages are not available in this deployment.');
  const body = title === '' ? DEFAULT_BODY : title;
  let messageId: string | null = null;
  let posted = false;
  if (mine && existing?.message_id) {
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
    if (status === 403) return refuse('forbidden', CANNOT_POST);
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
    return refuse(saved?.o_outcome ?? 'conflict', saved?.o_outcome === 'not_owner' ? NOT_YOURS : saved?.o_outcome === 'invalid' ? 'The list has the wrong shape.' : 'The list could not be saved. Read it again and try once more.');
  }
  // What the list says now: the write brought every item that names a card to the card's own state, so the counts are of that and not of what was sent.
  const stored = (await tx.query<{ items: unknown }>('SELECT items FROM app.thread_todos WHERE thread_root_id = $1::uuid', [here.o_root_id])).rows[0]?.items;
  const now = (Array.isArray(stored) ? stored : items).flatMap((raw) => {
    const parsed = TodoItem.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  await pushChanged(ctx, tx, here.o_workspace_id, saved.o_channel_id, saved.o_root_id, saved.o_version);
  const note =
    cleaned.redacted > 0
      ? ` ${cleaned.redacted === 1 ? 'One text' : `${cleaned.redacted} texts`} held something that looks like a secret, so it was replaced by a marker such as [redacted:api-key] in the list everyone in the thread reads. Do not put secrets in the list.`
      : '';
  return {
    ok: true,
    version: saved.o_version,
    counts: counts(now),
    ...(cleaned.redacted > 0 ? { redacted: cleaned.redacted } : {}),
    message: (posted ? 'The list is posted in the thread. Change one item with action "update"; send "set" again to replace the whole list.' : 'The list in the thread is updated.') + note,
  };
}

async function updateItem(ctx: PluginContext, tx: PluginTx, input: Extract<TodoToolInput, { action: 'update' }>): Promise<Record<string, unknown>> {
  const here = (await tx.query<Context>('SELECT * FROM app.todo_run_context()')).rows[0];
  if (!here) return refuse('no_thread', NO_THREAD);
  // A bot that can no longer post in the channel (removed, muted, the channel became read-only for it) does not go on changing the card its members read.
  if (!(await canPost(tx, here.o_channel_id))) return refuse('forbidden', CANNOT_POST);
  const out = (
    await tx.query<{ o_outcome: string; o_channel_id: string | null; o_root_id: string | null; o_version: number | null }>(
      'SELECT o_outcome, o_channel_id, o_root_id, o_version FROM app.todo_set_status($1, $2)',
      [input.id, input.status],
    )
  ).rows[0];
  switch (out?.o_outcome) {
    case 'saved':
      if (out.o_channel_id === null || out.o_root_id === null || out.o_version === null) return refuse('conflict', 'The list could not be saved.');
      await pushChanged(ctx, tx, here.o_workspace_id, out.o_channel_id, out.o_root_id, out.o_version);
      return { ok: true, version: out.o_version, id: input.id, status: input.status };
    case 'no_run':
      return refuse('no_thread', NO_THREAD);
    case 'no_list':
      return refuse('no_list', 'This thread has no to-do list yet. Make one with action "set".');
    case 'no_item':
      return refuse('no_item', `The list has no item with the id "${input.id}". Send "set" with the whole list to add one.`);
    default:
      return refuse('invalid_input', 'status: waiting, working, done or blocked.');
  }
}

/** The check the table keeps on a list's size (migration 0018); a follower leaves a list alone that a change would push past it. */
const FOLLOW_MAX_BYTES = 38_000;

/** The items that name a card follow it. Idempotent: an item already in the state asked for is left alone, so a delivery that comes twice changes nothing. */
async function follow(ctx: PluginContext, tx: PluginTx, workspaceId: string, teamId: string, taskId: string, status: TodoStatus, ownerId: string | null): Promise<void> {
  if (!UUID.test(taskId)) return;
  // In a fixed order, so two followers that lock the same lists cannot wait on each other.
  const rows = (
    await tx.query<TodoRow>(`SELECT ${COLUMNS} FROM app.thread_todos WHERE workspace_id = $1::uuid AND team_id = $3::uuid AND items @> $2::jsonb ORDER BY thread_root_id FOR UPDATE`, [workspaceId, JSON.stringify([{ taskId }]), teamId])
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
    const text = JSON.stringify(next);
    // A list the table's size check would refuse is left as it is: one list that is too full must not fail the event for every other list that follows the card.
    if (Buffer.byteLength(text, 'utf8') > FOLLOW_MAX_BYTES) continue;
    const updated = (
      await tx.query<{ version: number }>('UPDATE app.thread_todos SET items = $2::jsonb, version = version + 1, updated_at = now() WHERE thread_root_id = $1::uuid RETURNING version', [row.thread_root_id, text])
    ).rows[0];
    if (updated) await pushChanged(ctx, tx, workspaceId, row.channel_id, row.thread_root_id, updated.version);
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
    await follow(ctx, tx, event.workspaceId, event.teamId, event.taskId, 'working', event.toActorId);
  });
  ctx.events.subscribe('tasks.task.completed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TasksTaskCompletedEvent.parse(raw);
    await follow(ctx, tx, event.workspaceId, event.teamId, event.taskId, 'done', null);
  });
}
