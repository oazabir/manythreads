import { randomUUID } from 'node:crypto';
import { CapabilityBroker, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { ChannelTodosResponse, GetThreadTodoResponse, type ThreadTodo } from '@manythreads/shared';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clip } from '../src/todo.ts';
import { createWorld, ensureChannels, eventually, personas, type Persona, type World } from '../../channels/test/world.ts';

// `tasks.todo` end to end (PLAN P25-10): a real run of a bot that answers in a thread, the real messages provider, the real migration and its doors, the GET route as
// different people, and the items that follow a card (the tasks plugin's own events). The bots are made by hand; nothing here needs a model.

const { nadia, sameera, omar, lena } = personas;
const KEY = `sk-live-${'A1b2C3d4E5'.repeat(4)}`; // secret-scan:ignore a made-up key shape for the redaction tests
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

let w: World;
let dev = '';
let appPool: ReturnType<typeof createAppPool>;
let systemPool: ReturnType<typeof createSystemPool>;
let runs: ReturnType<typeof createRunService>;
let handler: (input: Record<string, unknown>, tx: PluginTx) => unknown;
let alpha = { botId: '', actorId: '' };
let beta = { botId: '', actorId: '' };

const makeBot = (slug: string): Promise<{ botId: string; actorId: string }> =>
  w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"},{"type":"conversation"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [nadia.workspaceId, TEAM_IDS.Engineering, slug],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [nadia.workspaceId, bot.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, nadia.workspaceId]);
    return { botId: bot.rows[0]!.id, actorId: actor.rows[0]!.id };
  });

/** A thread: a message of a person, and a run of the bot that answers under it. */
async function thread(b: { botId: string }, channelId = dev): Promise<{ root: string; run: BotRunHandle }> {
  const posted = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: `Please do the work ${randomUUID().slice(0, 6)}`, threadRootId: null });
  expect(posted.status).toBe(201);
  const run = (await runs.open({ botId: b.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId, replyRootId: posted.body.id })).run;
  return { root: posted.body.id, run };
}

const todo = (run: BotRunHandle, input: Record<string, unknown>): Promise<Record<string, unknown>> => runs.asBot(run, async (tx) => (await handler(input, tx)) as Record<string, unknown>);
const read = async (who: typeof nadia, root: string): Promise<ThreadTodo | null> => {
  const res = await w.call(who, 'GET', `/api/threads/${root}/todo`);
  expect(res.status).toBe(200);
  return GetThreadTodoResponse.parse(res.body).todo;
};
const todoMessages = (root: string) =>
  w.system(async (tx) => (await tx.query<{ id: string; body: string; meta: Record<string, unknown> }>("SELECT id, body, meta FROM app.messages WHERE thread_root_id = $1 AND meta ? 'todoRef' ORDER BY id", [root])).rows);

/** A request as a bot (the test world's `call` is for people). */
const asBot = async (actorId: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${w.server.url}${path}`, {
    method,
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: actorId, workspaceId: nadia.workspaceId }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const ITEMS = [
  { id: 'read', text: 'Read the code', status: 'done' },
  { id: 'write', text: 'Write the change', status: 'working' },
  { id: 'test', text: 'Run the tests', status: 'waiting' },
];

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  handler = w.server.host.registries.capabilityHandlers.get('tasks.todo')!.handler as never;
  alpha = await makeBot('todo-alpha');
  beta = await makeBot('todo-beta');
  appPool = createAppPool(w.server.db.appUrl);
  systemPool = createSystemPool(w.server.db.systemUrl, 2);
  runs = createRunService({
    pool: appPool,
    systemPool,
    registry: w.server.host.capabilities,
    broker: new CapabilityBroker({ registry: w.server.host.capabilities, grants: createDbGrantSource({ pool: systemPool }) }),
    handlers: w.server.host.registries.capabilityHandlers,
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
  await w?.close();
});

describe('the tool is every bot', () => {
  it('is a default, non-destructive capability, so a bot with no grant is offered it', async () => {
    expect(w.server.host.capabilities.get('tasks.todo')).toMatchObject({ plugin: 'tasks', destructive: false, default: true });
    const { run } = await thread(alpha);
    expect(await runs.authorize(run, 'tasks.todo', {})).toMatchObject({ allowed: true });
  });
});

describe('set and update', () => {
  it('posts ONE message with meta.todoRef, keeps the list, and rewrites it in place', async () => {
    const { root, run } = await thread(alpha);
    const made = await todo(run, { action: 'set', title: 'Ship the fix', items: ITEMS });
    expect(made).toMatchObject({ ok: true, version: 1, counts: { waiting: 1, working: 1, done: 1, blocked: 0 } });
    const [card] = await todoMessages(root);
    expect(card).toMatchObject({ body: 'Ship the fix', meta: { todoRef: root } });
    expect((await todoMessages(root)).length).toBe(1);

    const list = (await read(nadia, root))!;
    expect(list).toMatchObject({ rootId: root, channelId: dev, messageId: card!.id, botActorId: alpha.actorId, title: 'Ship the fix', version: 1 });
    expect(list.items.map((i) => [i.id, i.status])).toEqual([['read', 'done'], ['write', 'working'], ['test', 'waiting']]);

    // update one item: the same message, a new version
    expect(await todo(run, { action: 'update', id: 'write', status: 'done' })).toMatchObject({ ok: true, version: 2 });
    expect(await todo(run, { action: 'update', id: 'test', status: 'working' })).toMatchObject({ ok: true, version: 3 });
    expect((await read(nadia, root))!.items.map((i) => i.status)).toEqual(['done', 'done', 'working']);

    // a new `set` replaces the list in the same message; a new title edits that message, a same title does not
    expect(await todo(run, { action: 'set', title: 'Ship the fix', items: [...ITEMS, { id: 'ship', text: 'Ship it', status: 'waiting' }] })).toMatchObject({ ok: true, version: 4 });
    expect(await todo(run, { action: 'set', title: 'Ship the fix, v2', items: ITEMS })).toMatchObject({ ok: true, version: 5 });
    const after = await todoMessages(root);
    expect(after.length).toBe(1);
    expect(after[0]).toMatchObject({ id: card!.id, body: 'Ship the fix, v2' });
    const edited = await w.system(async (tx) => (await tx.query<{ edited_at: Date | null }>('SELECT edited_at FROM app.messages WHERE id = $1', [card!.id])).rows[0]!.edited_at);
    expect(edited).not.toBeNull();
    // nobody was woken or mentioned by it
    const mentions = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_mentions WHERE message_id = $1', [card!.id])).rows.length);
    expect(mentions).toBe(0);
  });

  it('refuses what is not a valid call, with a sentence', async () => {
    const { run } = await thread(alpha);
    expect(await todo(run, { action: 'set', items: [] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await todo(run, { action: 'set', items: Array.from({ length: 31 }, (_, i) => ({ id: `i${i}`, text: 'x', status: 'waiting' })) })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await todo(run, { action: 'set', items: [{ id: 'a', text: 'x'.repeat(201), status: 'waiting' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await todo(run, { action: 'set', items: [{ id: 'a', text: 'x', status: 'finished' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await todo(run, { action: 'set', items: [{ id: 'a', text: 'x', status: 'done' }, { id: 'a', text: 'y', status: 'waiting' }] })).toMatchObject({ ok: false, code: 'invalid_input', message: expect.stringContaining('same one') });
    expect(await todo(run, { action: 'set', items: [{ id: 'a', text: 'x', status: 'done', extra: 1 }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await todo(run, { action: 'wipe' })).toMatchObject({ ok: false, code: 'invalid_input' });
    // nothing was posted for any of it
    expect(await todo(run, { action: 'update', id: 'a', status: 'done' })).toMatchObject({ ok: false, code: 'no_list' });
  });

  it('says plainly when an item or a list is not there', async () => {
    const { run } = await thread(alpha);
    await todo(run, { action: 'set', items: ITEMS });
    expect(await todo(run, { action: 'update', id: 'nope', status: 'done' })).toMatchObject({ ok: false, code: 'no_item' });
    expect(await todo(run, { action: 'update', id: 'read', status: 'finished' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('keeps a secret out of the list that everyone in the thread reads', async () => {
    const { root, run } = await thread(alpha);
    const key = `sk-live-${'A1b2C3d4E5'.repeat(4)}`; // a made-up key shape for the redaction
    await todo(run, { action: 'set', items: [{ id: 'k', text: `Use the key ${key} for the call`, status: 'waiting' }] });
    const list = (await read(nadia, root))!;
    expect(JSON.stringify(list)).not.toContain(key);
  });
});

describe('who may do what', () => {
  it('lets only the bot that made the list replace it while that bot works in the thread, and posts nothing for a refused call', async () => {
    const mine = await thread(alpha);
    await todo(mine.run, { action: 'set', items: ITEMS });
    // another bot answering in the same thread
    const other = (await runs.open({ botId: beta.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: dev, replyRootId: mine.root })).run;
    expect(await todo(other, { action: 'set', items: [{ id: 'x', text: 'Take over', status: 'working' }] })).toMatchObject({ ok: false, code: 'not_owner' });
    expect((await todoMessages(mine.root)).length).toBe(1);
    expect((await read(nadia, mine.root))!.items.map((i) => i.id)).toEqual(['read', 'write', 'test']);
  });

  it('lets any bot with a live run in the thread change one item, and the list changes hands when its owner has no live run left', async () => {
    const mine = await thread(alpha);
    await todo(mine.run, { action: 'set', items: ITEMS });
    const other = (await runs.open({ botId: beta.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: dev, replyRootId: mine.root })).run;
    // a helper ticks what it did
    expect(await todo(other, { action: 'update', id: 'read', status: 'blocked' })).toMatchObject({ ok: true, version: 2 });
    expect((await read(nadia, mine.root))!.items[0]).toMatchObject({ id: 'read', status: 'blocked' });
    // a bot with no run in the thread cannot (it has no thread): the other thread's run is not this one
    const elsewhere = await thread(beta);
    expect(await todo(elsewhere.run, { action: 'update', id: 'read', status: 'done' })).toMatchObject({ ok: false, code: 'no_list' });

    // the owner's run ends: the other bot may now replace the whole list, and it is its own from then on, with a card of its own in the thread
    await w.system((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [mine.run.runId]));
    expect(await todo(other, { action: 'set', title: 'Taken over', items: [{ id: 'x', text: 'Take over', status: 'working' }] })).toMatchObject({ ok: true, version: 3 });
    const list = (await read(nadia, mine.root))!;
    expect(list).toMatchObject({ botActorId: beta.actorId, title: 'Taken over', version: 3 });
    const cards = await todoMessages(mine.root);
    expect(cards.length).toBe(2);
    expect(list.messageId).toBe(cards[1]!.id);
    // the first bot, in a new run, now meets a live owner
    const again = (await runs.open({ botId: alpha.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: dev, replyRootId: mine.root })).run;
    expect(await todo(again, { action: 'set', items: ITEMS })).toMatchObject({ ok: false, code: 'not_owner' });
    expect(await todo(again, { action: 'update', id: 'x', status: 'done' })).toMatchObject({ ok: true });
  });

  it('is for the thread the run answers in: a run with no thread, or one that has ended, is refused', async () => {
    const lone = (await runs.open({ botId: alpha.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId })).run;
    expect(await todo(lone, { action: 'set', items: ITEMS })).toMatchObject({ ok: false, code: 'no_thread' });
    const done = await thread(alpha);
    await w.system((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [done.run.runId]));
    // the runtime itself refuses a call from a run that has ended, before the tool is reached
    await expect(todo(done.run, { action: 'set', items: ITEMS })).rejects.toThrow(/has ended/);
  });

  it('is read by whoever can read the thread, and by nobody else; a person cannot change it', async () => {
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: ITEMS });
    expect(await read(nadia, root)).not.toBeNull();
    // sameera is on another team: the thread is not hers, and "no list" and "not yours" look the same
    expect(await read(sameera, root)).toBeNull();
    expect((await w.call(null, 'GET', `/api/threads/${root}/todo`)).status).toBe(401);
    // the table gives a person no way to write: the routes there are none, and the policy refuses a direct write
    expect((await w.call(nadia, 'PUT', `/api/threads/${root}/todo`, { items: [] })).status).toBeGreaterThanOrEqual(400);
    const direct = await w.system((tx) => tx.query("SELECT has_table_privilege('manythreads_app', 'app.thread_todos', 'INSERT') AS i, has_table_privilege('manythreads_app', 'app.thread_todos', 'UPDATE') AS u"));
    expect(direct.rows[0]).toEqual({ i: false, u: false });
  });

  it('works in a person\'s own conversation with the bot, which only that person reads', async () => {
    const chat = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/todo-alpha/conversation');
    expect(chat.status, JSON.stringify(chat.body)).toBeLessThan(300);
    const { root, run } = await thread(alpha, chat.body.channelId);
    expect(await todo(run, { action: 'set', title: 'In private', items: ITEMS })).toMatchObject({ ok: true, version: 1 });
    expect(await todo(run, { action: 'set', title: 'In private', items: ITEMS })).toMatchObject({ ok: true, version: 2 });
    expect((await todoMessages(root)).length).toBe(1);
    expect((await read(nadia, root))!.items).toHaveLength(3);
    expect(await read(omar, root)).toBeNull();
  });

  it('posts the list again when its message was deleted', async () => {
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: ITEMS });
    const [first] = await todoMessages(root);
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [first!.id]));
    expect(await todo(run, { action: 'set', items: ITEMS })).toMatchObject({ ok: true });
    const list = (await read(nadia, root))!;
    expect(list.messageId).not.toBe(first!.id);
    expect((await todoMessages(root)).filter((m) => m.id === list.messageId).length).toBe(1);
  });
});

describe('items that follow a card', () => {
  const card = async (): Promise<string> => {
    const made = await w.call<{ task: { id: string } }>(nadia, 'POST', '/api/teams/engineering/tasks', { title: 'A card', branch: `todo/${randomUUID().slice(0, 6)}` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.task.id;
  };

  it('refuses a card the bot cannot read, and takes the owner of a card at the time of the list', async () => {
    const { run } = await thread(alpha);
    expect(await todo(run, { action: 'set', items: [{ id: 'c', text: 'x', status: 'waiting', taskId: randomUUID() }] })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('turns working with the card\'s new owner on a handover, and done when the card is finished, without waking anyone', async () => {
    const taskId = await card();
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'waiting', taskId }, { id: 'p', text: 'A plain item', status: 'waiting' }] });
    const messagesBefore = (await w.system((tx) => tx.query('SELECT 1 FROM app.messages WHERE thread_root_id = $1', [root]))).rows.length;

    await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`);
    const moved = await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/handoff`, { toActorId: beta.actorId, mode: 'bot', note: 'build it' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const working = await eventually(async () => {
      const l = (await read(nadia, root))!;
      return l.items.find((i) => i.id === 'c')?.status === 'working' ? l : undefined;
    }, 30_000, 'the item to follow the handover');
    expect(working.items.find((i) => i.id === 'c')).toMatchObject({ status: 'working', ownerId: beta.actorId, taskId });
    expect(working.items.find((i) => i.id === 'p')?.status).toBe('waiting');
    const v = working.version;

    const done = await asBot(beta.actorId, 'POST', `/api/teams/engineering/tasks/${taskId}/complete`, { testedSha: 'abcdef1' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const ticked = await eventually(async () => {
      const l = (await read(nadia, root))!;
      return l.items.find((i) => i.id === 'c')?.status === 'done' ? l : undefined;
    }, 30_000, 'the item to follow the finished card');
    expect(ticked.version).toBeGreaterThan(v);
    expect(ticked.items.find((i) => i.id === 'p')?.status).toBe('waiting');
    // the list changed on its own: no message was posted for it
    expect((await w.system((tx) => tx.query('SELECT 1 FROM app.messages WHERE thread_root_id = $1', [root]))).rows.length).toBe(messagesBefore);
  });

  it('starts a finished card as done when the list is made', async () => {
    const taskId = await card();
    await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`);
    await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/complete`, { testedSha: 'abcdef1' });
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: [{ id: 'c', text: 'Already finished', status: 'waiting', taskId }] });
    expect((await read(nadia, root))!.items[0]).toMatchObject({ status: 'done', taskId });
  });
});

/** A WebSocket signed in through the test-only dev header, collecting the frames it is sent. */
class Socket {
  readonly frames: Array<{ type: string; id: string; payload: Record<string, unknown> }> = [];
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => void this.frames.push(JSON.parse(String(e.data)));
  }
  static async open(url: string, who: Persona): Promise<Socket> {
    const header = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { 'x-manythreads-dev-actor': header } } as never);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('socket failed to open'));
    });
    const s = new Socket(ws);
    ws.send(JSON.stringify({ type: 'ping', id: 'hello', payload: {} }));
    await s.waitFor((f) => f.type === 'pong');
    await new Promise((r) => setTimeout(r, 150));
    return s;
  }
  async waitFor(match: (f: Socket['frames'][number]) => boolean, ms = 3_000): Promise<Socket['frames'][number] | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit || Date.now() > until) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  todo(root: string) {
    return this.frames.filter((f) => f.type === 'todo.changed' && f.payload['rootId'] === root);
  }
  close(): void {
    this.ws.close();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A call of the door itself (the SQL function), as the bot of the run: for what the tool never sends. */
const door = (run: BotRunHandle, sql: string, params: unknown[]) => runs.asBot(run, async (tx) => (await tx.query<Record<string, unknown>>(sql, params)).rows);
const end = (run: BotRunHandle) => w.system((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [run.runId]));

describe('the channel\'s lists in one read (P29-03)', () => {
  const readChannel = async (who: typeof nadia, channelId: string): Promise<ThreadTodo[]> => {
    const res = await w.call<{ todos: ThreadTodo[] }>(who, 'GET', `/api/channels/${channelId}/todos`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ChannelTodosResponse.parse(res.body).todos;
  };

  it('answers the open lists of the channel and the lists finished a moment ago; not an old finished list, not an old stale one', async () => {
    const open = await thread(alpha);
    await todo(open.run, { action: 'set', items: ITEMS });
    const justDone = await thread(alpha);
    await todo(justDone.run, { action: 'set', items: ITEMS.map((i) => ({ ...i, status: 'done' })) });
    const oldDone = await thread(alpha);
    await todo(oldDone.run, { action: 'set', items: ITEMS.map((i) => ({ ...i, status: 'done' })) });
    const oldOpen = await thread(alpha);
    await todo(oldOpen.run, { action: 'set', items: ITEMS });
    await w.system((tx) => tx.query("UPDATE app.thread_todos SET updated_at = now() - interval '10 minutes' WHERE thread_root_id = $1", [oldDone.root]));
    await w.system((tx) => tx.query("UPDATE app.thread_todos SET updated_at = now() - interval '25 hours' WHERE thread_root_id = $1", [oldOpen.root]));
    const roots = (await readChannel(nadia, dev)).map((t) => t.rootId);
    expect(roots).toContain(open.root);
    expect(roots).toContain(justDone.root);
    expect(roots).not.toContain(oldDone.root);
    expect(roots).not.toContain(oldOpen.root);
    // an older list that still has work, changed 3 hours ago, stays
    await w.system((tx) => tx.query("UPDATE app.thread_todos SET updated_at = now() - interval '3 hours' WHERE thread_root_id = $1", [open.root]));
    expect((await readChannel(nadia, dev)).map((t) => t.rootId)).toContain(open.root);
  });

  it('is the table\'s rule: another team, a person\'s own conversation and a guest without a grant read nothing; a guest with a grant reads the lists of that channel', async () => {
    const chat = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/todo-alpha/conversation');
    const releases = await w.channelId('engineering', 'releases');
    await w.system((tx) => tx.query("INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING", [nadia.workspaceId, releases, lena.personId]));
    const priv = await thread(alpha, chat.body.channelId);
    await todo(priv.run, { action: 'set', items: ITEMS });
    const shared = await thread(alpha, releases);
    await todo(shared.run, { action: 'set', items: ITEMS });
    const mine = (await readChannel(nadia, chat.body.channelId)).map((t) => t.rootId);
    expect(mine).toContain(priv.root);
    expect(mine).not.toContain(shared.root);
    expect(await readChannel(omar, chat.body.channelId)).toEqual([]);
    expect(await readChannel(sameera, dev)).toEqual([]);
    expect(await readChannel(lena, dev)).toEqual([]);
    expect((await readChannel(lena, releases)).map((t) => t.rootId)).toContain(shared.root);
    expect((await w.call(null, 'GET', `/api/channels/${dev}/todos`)).status).toBe(401);
  });
});

describe('who can see it, and who is told', () => {
  it('in a person\'s own conversation only that person is told and reads it; a guest reads it only in a channel she was added to', async () => {
    const chat = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/todo-alpha/conversation');
    const releases = await w.channelId('engineering', 'releases');
    // the guest's grant of the seeded story (a read grant on #releases), made here because this world has no content seed
    await w.system((tx) => tx.query("INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING", [nadia.workspaceId, releases, lena.personId]));
    const [sNadia, sOmar, sLena] = await Promise.all([Socket.open(w.server.url, nadia), Socket.open(w.server.url, omar), Socket.open(w.server.url, lena)]);
    try {
      const priv = await thread(alpha, chat.body.channelId);
      await todo(priv.run, { action: 'set', items: ITEMS });
      expect(await sNadia.waitFor((f) => f.type === 'todo.changed' && f.payload['rootId'] === priv.root)).toMatchObject({ payload: { rootId: priv.root, channelId: chat.body.channelId, version: 1 } });
      const open = await thread(alpha, releases);
      await todo(open.run, { action: 'set', items: ITEMS });
      expect(await sLena.waitFor((f) => f.type === 'todo.changed' && f.payload['rootId'] === open.root)).toBeDefined();
      const hidden = await thread(alpha, dev);
      await todo(hidden.run, { action: 'set', items: ITEMS });
      await sNadia.waitFor((f) => f.type === 'todo.changed' && f.payload['rootId'] === hidden.root);
      await sleep(400);
      // omar is not in nadia's conversation; lena is a guest of #releases only
      expect(sOmar.todo(priv.root)).toEqual([]);
      expect(sLena.todo(priv.root)).toEqual([]);
      expect(sLena.todo(hidden.root)).toEqual([]);
      expect(sOmar.todo(hidden.root).length).toBe(1);
      expect(await read(omar, priv.root)).toBeNull();
      expect(await read(lena, priv.root)).toBeNull();
      expect(await read(lena, hidden.root)).toBeNull();
      expect(await read(lena, open.root)).not.toBeNull();
    } finally {
      sNadia.close();
      sOmar.close();
      sLena.close();
    }
  });

  it('pushes nothing for a call that was refused', async () => {
    const mine = await thread(alpha);
    await todo(mine.run, { action: 'set', items: ITEMS });
    const other = (await runs.open({ botId: beta.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: dev, replyRootId: mine.root })).run;
    const s = await Socket.open(w.server.url, nadia);
    try {
      await sleep(600); // past the gap of the first push
      expect(await todo(other, { action: 'set', items: [{ id: 'x', text: 'Take over', status: 'working' }] })).toMatchObject({ ok: false, code: 'not_owner' });
      expect(await todo(other, { action: 'update', id: 'nope', status: 'done' })).toMatchObject({ ok: false, code: 'no_item' });
      expect(await todo(other, { action: 'set', items: [{ id: 'x', text: `my key ${KEY}`, status: 'working' }, { id: 'x', text: 'same id', status: 'working' }] })).toMatchObject({ ok: false });
      await sleep(800);
      expect(s.todo(mine.root)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('tells a list once or twice a second at the most, and always ends with the last version', async () => {
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: ITEMS });
    const s = await Socket.open(w.server.url, nadia);
    try {
      await sleep(600);
      const before = s.todo(root).length;
      let version = 1;
      for (let n = 0; n < 8; n++) {
        const out = await todo(run, { action: 'update', id: 'test', status: n % 2 === 0 ? 'working' : 'waiting' });
        version = out['version'] as number;
      }
      expect(version).toBe(9);
      await s.waitFor((f) => f.type === 'todo.changed' && f.payload['rootId'] === root && f.payload['version'] === 9, 4_000);
      const frames = s.todo(root).slice(before);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames.length).toBeLessThanOrEqual(4); // eight changes, never eight pushes
      expect(frames[frames.length - 1]!.payload['version']).toBe(9);
    } finally {
      s.close();
    }
  });

  it('is refused where it cannot be kept: a person who forges meta.todoRef gets 403, a channel that was archived mid-run has no thread for it, a bot that can no longer post cannot tick', async () => {
    const mine = await thread(alpha);
    const forged = await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'a card', threadRootId: mine.root, meta: { todoRef: mine.root } });
    expect([400, 403]).toContain(forged.status); // the person route's strict schema does not know the key; the bot route says 403
    expect((await todoMessages(mine.root)).length).toBe(0);

    const made = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: `todo-arch-${randomUUID().slice(0, 5)}` });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const gone = await thread(alpha, made.body.channel.id);
    await todo(gone.run, { action: 'set', items: ITEMS });
    expect((await w.call(omar, 'POST', `/api/channels/${made.body.channel.id}/archive`)).status).toBeLessThan(300);
    expect(await todo(gone.run, { action: 'set', items: ITEMS })).toMatchObject({ ok: false, code: 'no_thread' });
    expect(await todo(gone.run, { action: 'update', id: 'read', status: 'blocked' })).toMatchObject({ ok: false, code: 'no_thread' });

    // the bot leaves the team's channels: its run is still live, its posting right is gone
    await todo(mine.run, { action: 'set', items: ITEMS });
    const row = await w.system(async (tx) => (await tx.query<{ role: string }>('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2 RETURNING role', [TEAM_IDS.Engineering, alpha.actorId])).rows[0]);
    try {
      expect(await todo(mine.run, { action: 'update', id: 'read', status: 'blocked' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await todo(mine.run, { action: 'set', items: ITEMS })).toMatchObject({ ok: false, code: 'forbidden' });
    } finally {
      if (row) await w.system((tx) => tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, $4)", [TEAM_IDS.Engineering, alpha.actorId, nadia.workspaceId, row.role]));
    }
  });
});

describe('what the list holds', () => {
  it('redacts every text in ONE data-loss call, says how many were changed, and keeps the title\'s secret out of the message too', async () => {
    const { root, run } = await thread(alpha);
    const before = await w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.events WHERE type = 'guardrails.dlp.decided' AND payload ->> 'destination' = 'channel' AND payload ->> 'botId' = $1", [alpha.botId])).rows[0]!.n));
    const out = await todo(run, {
      action: 'set',
      title: `Deploy with ${KEY}`,
      items: [
        { id: 'a', text: `Use the key ${KEY} for the call`, status: 'waiting' },
        { id: 'b', text: 'A plain item with nothing in it', status: 'waiting' },
        { id: 'c', text: 'Send Bearer abcdefghijklmnopqrstuvwxyz0123 with it', status: 'waiting' },
      ],
    });
    expect(out).toMatchObject({ ok: true, redacted: 3, message: expect.stringContaining('3 texts held something that looks like a secret') });
    const list = (await read(nadia, root))!;
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.title).toContain('[redacted:api-key]');
    expect(list.items[0]!.text).toContain('[redacted:api-key]');
    expect(list.items[1]!.text).toBe('A plain item with nothing in it');
    expect(list.items[2]!.text).toContain('[redacted:bearer-token]');
    const [card] = await todoMessages(root);
    expect(card!.body).not.toContain(KEY);
    expect(card!.body).toContain('[redacted:');
    // one call to the chain, one audit line, for this bot and the `channel` destination
    const after = await w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.events WHERE type = 'guardrails.dlp.decided' AND payload ->> 'destination' = 'channel' AND payload ->> 'botId' = $1", [alpha.botId])).rows[0]!.n));
    expect(after - before).toBe(1);
    // nothing to say about a list with nothing in it
    expect(await todo(run, { action: 'set', items: ITEMS })).not.toHaveProperty('redacted');
  });

  it('keeps a plain text exactly: Arabic, Chinese, emoji, quotes, a backslash and markup come back as they went in', async () => {
    const { root, run } = await thread(alpha);
    const texts = ['مرحبا بالعالم، هذه مهمة', '日本語のテキスト 你好', 'Smile 😀 and 👨‍👩‍👧', 'He said "yes" and it\'s fine', 'path C:\\work\\x and <b>bold</b> & more', 'tab\tinside'];
    const items = texts.map((text, n) => ({ id: `t${n}`, text, status: 'waiting' }));
    expect(await todo(run, { action: 'set', title: 'عنوان القائمة 日本', items })).toMatchObject({ ok: true });
    const list = (await read(nadia, root))!;
    expect(list.items.map((i) => i.text)).toEqual(texts);
    expect(list.title).toBe('عنوان القائمة 日本');
  });

  it('holds thirty items of four-byte characters at the limit, and cuts a text that grew by redaction without splitting a character', async () => {
    const { root, run } = await thread(alpha);
    const emoji = '😀'.repeat(100); // 200 UTF-16 units, 400 bytes
    const items = Array.from({ length: 30 }, (_, n) => ({ id: `e${n}`, text: emoji, status: 'waiting' }));
    expect(await todo(run, { action: 'set', title: '😀'.repeat(60), items })).toMatchObject({ ok: true, counts: { waiting: 30 } });
    const list = (await read(nadia, root))!;
    expect(list.items).toHaveLength(30);
    expect(list.items.every((i) => i.text === emoji)).toBe(true);
    expect(list.title).toBe('😀'.repeat(60));

    // a text of short secrets grows when each is replaced by a marker: it is cut at 200 units, whole characters only, and still reads back
    const grown = '😀'.repeat(10) + 'ab://u:p@ '.repeat(18);
    expect(await todo(run, { action: 'set', items: [{ id: 'g', text: grown, status: 'waiting' }] })).toMatchObject({ ok: true, redacted: 1 });
    const text = (await read(nadia, root))!.items[0]!.text;
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false); // no half of a pair
    expect(clip('😀😀😀', 4)).toBe('😀…');
    expect(clip('abc', 5)).toBe('abc');
  });

  it('refuses a list that is too heavy in bytes, with a sentence, and posts nothing for it', async () => {
    const { root, run } = await thread(alpha);
    // a control character is six bytes in JSON; thirty items of two hundred of them are far past the limit although each text is short enough
    const heavy = `a${'\u0001'.repeat(199)}`;
    const out = await todo(run, { action: 'set', items: Array.from({ length: 30 }, (_, n) => ({ id: `h${n}`, text: heavy, status: 'waiting' })) });
    expect(out).toMatchObject({ ok: false, code: 'invalid_input', message: expect.stringContaining('too large') });
    expect((await todoMessages(root)).length).toBe(0);
    expect(await read(nadia, root)).toBeNull();
  });

  it('refuses the whole call, and posts nothing, when no data-loss plugin is installed to check the text', async () => {
    const { root, run } = await thread(alpha);
    const registry = w.server.host.registries.preEgress;
    const all = registry.list();
    const spy = vi.spyOn(registry, 'list').mockReturnValue(all.filter((e) => e.plugin !== 'guardrails-dlp'));
    try {
      expect(await todo(run, { action: 'set', title: 'A title', items: ITEMS })).toMatchObject({ ok: false, code: 'unavailable', message: expect.stringContaining('data-loss check') });
    } finally {
      spy.mockRestore();
    }
    expect((await todoMessages(root)).length).toBe(0);
    expect(await read(nadia, root)).toBeNull();
    // and it works again once the chain is back
    expect(await todo(run, { action: 'set', items: ITEMS })).toMatchObject({ ok: true });
  });

  it('does one thing at a time per thread: two sets at once make one card and two versions', async () => {
    const { root, run } = await thread(alpha);
    const [a, b] = await Promise.all([todo(run, { action: 'set', title: 'One', items: ITEMS }), todo(run, { action: 'set', title: 'Two', items: ITEMS.slice(0, 2) })]);
    expect([a['ok'], b['ok']]).toEqual([true, true]);
    expect([a['version'], b['version']].sort()).toEqual([1, 2]);
    expect((await todoMessages(root)).length).toBe(1);
    const list = (await read(nadia, root))!;
    expect(list.version).toBe(2);
    // the message says what the list's title says
    expect((await todoMessages(root))[0]!.body).toBe(list.title);
  });
});

describe('the door itself', () => {
  const written = (run: BotRunHandle, title: string, items: unknown, messageId: string | null) =>
    door(run, 'SELECT o_outcome FROM app.todo_write($1, $2::jsonb, $3::uuid)', [title, JSON.stringify(items), messageId]).then((rows) => rows[0]!['o_outcome']);

  it('takes a message only when it is this bot\'s own card of this thread: another thread, another author, a person\'s message, a deleted one are bad_message', async () => {
    const one = await thread(alpha);
    await todo(one.run, { action: 'set', items: ITEMS });
    const two = await thread(alpha);
    await todo(two.run, { action: 'set', items: ITEMS });
    const [mine] = await todoMessages(one.root);
    const [elsewhere] = await todoMessages(two.root);
    const person = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'a message', threadRootId: one.root });
    // the card of another thread
    expect(await written(one.run, '', ITEMS, elsewhere!.id)).toBe('bad_message');
    // a message of a person
    expect(await written(one.run, '', ITEMS, person.body.id)).toBe('bad_message');
    // a message that does not exist
    expect(await written(one.run, '', ITEMS, randomUUID())).toBe('bad_message');
    // the card of this thread, but written by another bot: the owner's run ended, beta takes the list and names alpha's card
    const helper = (await runs.open({ botId: beta.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: dev, replyRootId: one.root })).run;
    await end(one.run);
    expect(await written(helper, '', ITEMS, mine!.id)).toBe('bad_message');
    // a deleted card
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [mine!.id]));
    const again = await thread(alpha);
    await todo(again.run, { action: 'set', items: ITEMS });
    const [card] = await todoMessages(again.root);
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [card!.id]));
    expect(await written(again.run, '', ITEMS, card!.id)).toBe('bad_message');
    // nothing the bad calls tried was kept
    expect((await read(nadia, one.root))!.items.map((i) => i.id)).toEqual(['read', 'write', 'test']);
  });

  it('keeps no list of the wrong shape: other keys, a bad status or id, a long text, a repeated id, a title too long, not an array', async () => {
    const { run } = await thread(alpha);
    const ok = { id: 'a', text: 'x', status: 'waiting' };
    for (const bad of [
      [{ ...ok, extra: 1 }],
      [{ ...ok, status: 'finished' }],
      [{ ...ok, id: 'has space' }],
      [{ ...ok, text: 'x'.repeat(201) }],
      [{ ...ok, text: 5 }],
      [{ ...ok, taskId: 'not-a-uuid' }],
      [{ ...ok, ownerId: 7 }],
      [ok, { ...ok }],
      ['a string'],
      { not: 'an array' },
    ]) expect(await written(run, '', bad, null), JSON.stringify(bad)).toBe('invalid');
    expect(await written(run, 'x'.repeat(121), [ok], null)).toBe('invalid');
    expect(await written(run, '', Array.from({ length: 31 }, (_, n) => ({ ...ok, id: `i${n}` })), null)).toBe('invalid');
    expect(await written(run, '', [ok], null)).toBe('saved');
  });
});

describe('items that follow a card, again', () => {
  const card = async (who: Persona = nadia, team = 'engineering'): Promise<string> => {
    const made = await w.call<{ task: { id: string } }>(who, 'POST', `/api/teams/${team}/tasks`, { title: 'A card', branch: `todo/${randomUUID().slice(0, 6)}` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.task.id;
  };
  const subscriber = (type: string) => w.server.host.registries.eventSubscriptions.list().find((e) => e.plugin === 'tasks' && e.value.type === type)!.value.handler;
  const completedEvent = (taskId: string) => ({ type: 'tasks.task.completed', schemaVersion: 1, workspaceId: nadia.workspaceId, teamId: TEAM_IDS.Engineering, taskId, kind: 'code', actorId: nadia.actorId, testedSha: null });
  const handedEvent = (taskId: string) => ({ type: 'tasks.task.handed_off', schemaVersion: 1, workspaceId: nadia.workspaceId, teamId: TEAM_IDS.Engineering, taskId, handoffId: randomUUID(), fromActorId: nadia.actorId, toActorId: beta.actorId, mode: 'bot', approvalId: null, note: '' });
  const deliver = (type: string, event: Record<string, unknown>) => w.system((tx) => Promise.resolve(subscriber(type)(event as never, tx as never)));

  it('takes the owner of the card when the list is made', async () => {
    const taskId = await card();
    expect((await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`)).status).toBe(200);
    const { root, run } = await thread(alpha);
    expect(await todo(run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'waiting', taskId }] })).toMatchObject({ ok: true });
    expect((await read(nadia, root))!.items[0]).toMatchObject({ taskId, status: 'waiting', ownerId: nadia.actorId });
  });

  it('is limited to the cards of the thread\'s own team: a card of an unreadable team, and a real card the door is handed anyway', async () => {
    const other = await card(sameera, 'customer-support');
    const { root, run } = await thread(alpha);
    expect(await todo(run, { action: 'set', items: [{ id: 'c', text: 'Not ours', status: 'waiting', taskId: other }] })).toMatchObject({ ok: false, code: 'invalid_input', message: expect.stringContaining('not a card of this thread') });
    expect((await todoMessages(root)).length).toBe(0);
    // a caller that is not the tool and names it anyway: the item is kept as sent and never follows that card
    await w.call(sameera, 'POST', `/api/teams/customer-support/tasks/${other}/claim`);
    await w.call(sameera, 'POST', `/api/teams/customer-support/tasks/${other}/complete`, { testedSha: 'abcdef1' });
    const rows = await door(run, 'SELECT o_outcome FROM app.todo_write($1, $2::jsonb, NULL)', ['', JSON.stringify([{ id: 'c', text: 'Not ours', status: 'waiting', taskId: other }])]);
    expect(rows[0]!['o_outcome']).toBe('saved');
    expect((await read(nadia, root))!.items[0]).toMatchObject({ status: 'waiting' });
    expect((await read(nadia, root))!.items[0]).not.toHaveProperty('ownerId');
  });

  it('brings an item to the card\'s state when the card finished while the list was being made (the write re-reads the cards)', async () => {
    const taskId = await card();
    await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`);
    await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/complete`, { testedSha: 'abcdef1' });
    const { root, run } = await thread(alpha);
    // the door is handed a list that was read before the card finished: the item says waiting and has no owner
    const rows = await door(run, 'SELECT o_outcome FROM app.todo_write($1, $2::jsonb, NULL)', ['', JSON.stringify([{ id: 'c', text: 'Finished meanwhile', status: 'waiting', taskId }])]);
    expect(rows[0]!['o_outcome']).toBe('saved');
    expect((await read(nadia, root))!.items[0]).toMatchObject({ status: 'done', ownerId: nadia.actorId, taskId });
    // and the counts the tool answers are of what is kept
    expect(await todo(run, { action: 'set', items: [{ id: 'c', text: 'Finished meanwhile', status: 'waiting', taskId }, { id: 'p', text: 'Plain', status: 'waiting' }] })).toMatchObject({ ok: true, counts: { done: 1, waiting: 1 } });
  });

  it('follows one card in several lists, ignores a delivery that comes twice, and never undoes a finished item', async () => {
    const taskId = await card();
    const one = await thread(alpha);
    const two = await thread(beta);
    for (const t of [one, two]) await todo(t.run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'waiting', taskId }, { id: 'p', text: 'Plain', status: 'waiting' }] });
    await deliver('tasks.task.handed_off', handedEvent(taskId));
    for (const t of [one, two]) expect((await read(nadia, t.root))!.items[0]).toMatchObject({ status: 'working', ownerId: beta.actorId });
    const version = (await read(nadia, one.root))!.version;
    await deliver('tasks.task.handed_off', handedEvent(taskId)); // the same again
    expect((await read(nadia, one.root))!.version).toBe(version);

    await deliver('tasks.task.completed', completedEvent(taskId));
    await deliver('tasks.task.completed', completedEvent(taskId));
    for (const t of [one, two]) {
      const list = (await read(nadia, t.root))!;
      expect(list.items[0]!.status).toBe('done');
      expect(list.items[1]!.status).toBe('waiting');
      expect(list.version).toBe(version + 1);
    }
    // a handover that is delivered late (after the card finished) does not undo it
    await deliver('tasks.task.handed_off', handedEvent(taskId));
    for (const t of [one, two]) expect((await read(nadia, t.root))!.items[0]!.status).toBe('done');
  });

  it('is not followed by a list of another team, and a card that is opened again lets the bot say what it says', async () => {
    const taskId = await card();
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'waiting', taskId }] });
    // an event of another team about the same id changes nothing
    await w.system((tx) => Promise.resolve(subscriber('tasks.task.completed')({ ...completedEvent(taskId), teamId: TEAM_IDS.Marketing } as never, tx as never)));
    expect((await read(nadia, root))!.items[0]!.status).toBe('waiting');
    await deliver('tasks.task.completed', completedEvent(taskId));
    expect((await read(nadia, root))!.items[0]!.status).toBe('done');
    // the card is opened again: the item stays as the list says until the bot says otherwise, and a new set takes the bot's own status
    await w.system((tx) => tx.query("UPDATE app.tasks SET state = 'in_progress', completed_at = NULL, tested_sha = NULL WHERE id = $1", [taskId]));
    expect(await todo(run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'working', taskId }] })).toMatchObject({ ok: true, counts: { working: 1, done: 0 } });
    expect((await read(nadia, root))!.items[0]!.status).toBe('working');
  });

  it('does not lose an update that comes while the card finishes: both land', async () => {
    const taskId = await card();
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'waiting', taskId }, { id: 'p', text: 'Plain', status: 'waiting' }] });
    await w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/claim`);
    const [u, done] = await Promise.all([todo(run, { action: 'update', id: 'p', status: 'done' }), w.call(nadia, 'POST', `/api/teams/engineering/tasks/${taskId}/complete`, { testedSha: 'abcdef1' })]);
    expect(u).toMatchObject({ ok: true });
    expect(done.status).toBe(200);
    const list = await eventually(async () => {
      const l = (await read(nadia, root))!;
      return l.items.every((i) => i.status === 'done') ? l : undefined;
    }, 30_000, 'both the update and the card to land');
    expect(list.items.map((i) => i.status)).toEqual(['done', 'done']);
  });

  it('catches up when a run of the list\'s owner ends: a card that finished unseen ticks its item, and only the owner\'s lists are looked at (P26-04)', async () => {
    const taskId = await card();
    const mine = await thread(alpha);
    const theirs = await thread(beta);
    for (const t of [mine, theirs]) await todo(t.run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'working', taskId }, { id: 'p', text: 'Plain', status: 'waiting' }] });
    // the card finished with no event delivered to the lists (a delivery that was missed)
    await w.system((tx) => tx.query("UPDATE app.tasks SET state = 'done', completed_at = now(), tested_sha = 'abcdef1' WHERE id = $1", [taskId]));
    expect((await read(nadia, mine.root))!.items[0]!.status).toBe('working');
    const closed = (botId: string) => ({ type: 'bots.run.closed', schemaVersion: 1, workspaceId: nadia.workspaceId, teamId: TEAM_IDS.Engineering, botId, runId: randomUUID(), trigger: 'mention', status: 'done' });
    // the plugin has more than one subscriber of this event (the card activity too): the event goes to all of them, as the outbox does
    const deliverClosed = (botId: string) => w.system(async (tx) => { for (const e of w.server.host.registries.eventSubscriptions.list().filter((x) => x.plugin === 'tasks' && x.value.type === 'bots.run.closed')) await e.value.handler(closed(botId) as never, tx as never); });
    await deliverClosed(alpha.botId);
    const list = (await read(nadia, mine.root))!;
    expect(list.items.map((i) => i.status)).toEqual(['done', 'waiting']);
    // the other bot's list is not touched by this bot's run ending, and a second delivery changes nothing
    expect((await read(nadia, theirs.root))!.items[0]!.status).toBe('working');
    await deliverClosed(alpha.botId);
    expect((await read(nadia, mine.root))!.version).toBe(list.version);
    await deliverClosed(beta.botId);
    expect((await read(nadia, theirs.root))!.items[0]!.status).toBe('done');
  });

  it('leaves a list alone that a change would make too heavy, without failing the event', async () => {
    const taskId = await card();
    const { root, run } = await thread(alpha);
    await todo(run, { action: 'set', items: [{ id: 'c', text: 'The card', status: 'waiting', taskId }] });
    // a list that is close to the size the table allows (written straight, as only a bug or an old version could)
    const fat = Array.from({ length: 30 }, (_, n) => ({ id: `f${n}`, text: '\u0001'.repeat(260), status: 'waiting', ...(n === 0 ? { taskId } : {}) }));
    await w.system((tx) => tx.query('UPDATE app.thread_todos SET items = $2::jsonb WHERE thread_root_id = $1', [root, JSON.stringify(fat)]));
    const v = (await read(nadia, root))!.version;
    await expect(deliver('tasks.task.completed', completedEvent(taskId))).resolves.toBeUndefined();
    expect((await read(nadia, root))!.version).toBe(v);
  });
});
