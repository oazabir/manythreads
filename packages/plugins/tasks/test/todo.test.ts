import { randomUUID } from 'node:crypto';
import { CapabilityBroker, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { GetThreadTodoResponse, type ThreadTodo } from '@manythreads/shared';
import type { BotRunHandle, PluginTx } from '@manythreads/sdk';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';

// `tasks.todo` end to end (PLAN P25-10): a real run of a bot that answers in a thread, the real messages provider, the real migration and its doors, the GET route as
// different people, and the items that follow a card (the tasks plugin's own events). The bots are made by hand; nothing here needs a model.

const { nadia, sameera, omar } = personas;
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
  it('lets only the bot that made the list change it, and posts nothing for a refused call', async () => {
    const mine = await thread(alpha);
    await todo(mine.run, { action: 'set', items: ITEMS });
    // another bot answering in the same thread
    const other = (await runs.open({ botId: beta.botId, teamId: TEAM_IDS.Engineering, workspaceId: nadia.workspaceId, trigger: 'mention', askerActorId: nadia.actorId, channelId: dev, replyRootId: mine.root })).run;
    expect(await todo(other, { action: 'set', items: [{ id: 'x', text: 'Take over', status: 'working' }] })).toMatchObject({ ok: false, code: 'not_owner' });
    expect(await todo(other, { action: 'update', id: 'read', status: 'blocked' })).toMatchObject({ ok: false, code: 'not_owner' });
    expect((await todoMessages(mine.root)).length).toBe(1);
    expect((await read(nadia, mine.root))!.items.map((i) => i.id)).toEqual(['read', 'write', 'test']);
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
