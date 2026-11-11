import { randomUUID } from 'node:crypto';
import { getOneOrCreate, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGoalCapabilities } from '../src/goals.ts';

// The goal tools against the real database (migration 0016): `goals.ensure` finds or makes the goal of the thread a run answers in (the same goal for
// a restarted run, a number per team), `goals.plan` sets the steps (a foreign bot or a thirteenth step is refused), and `tasks.goal` reads the plan.

const { nadia } = personas;
const WS = KAHF_WORKSPACE_ID;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];

let server: TestServer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: server.pools.system, workspaceId: WS });
const asBot = <T>(actor: string, runId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: actor, workspaceId: WS, ...(runId ? { runId } : {}) } as Actor, fn, { pool: server.pools.app });
const asPerson = <T>(id: string, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor({ kind: 'person', id, workspaceId: WS } as Actor, fn, { pool: server.pools.app });

type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>;
const handlers = new Map<string, Handler>();
const events: Array<Record<string, unknown>> = [];
const tool = (name: string, actor: string, runId: string | null, input: Record<string, unknown>): Promise<Out> =>
  asBot(actor, runId, (tx) => handlers.get(name)!(input, tx as unknown as PluginTx)) as Promise<Out>;

const uniq = (p: string): string => `${p}-${randomUUID().slice(0, 6)}`;

async function makeBot(team: string, name?: string): Promise<{ bot: string; actor: string; slug: string }> {
  return sys(async (tx) => {
    const slug = uniq('gb');
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, $3, $4, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [WS, team, slug, name ?? slug],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, bot])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [team, actor, WS]);
    return { bot, actor, slug };
  });
}
async function channel(team: string | null, kind = 'channel'): Promise<string> {
  return sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [WS, team, uniq('g'), kind, kind !== 'channel', kind === 'dm' ? randomUUID() : null, nadia.actorId],
        )
      ).rows[0]!.id,
  );
}
const message = (ch: string, author: string, root: string | null = null): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'hi', 'hi', $4) RETURNING id`,
          [WS, ch, author, root],
        )
      ).rows[0]!.id,
  );
const openRun = (bot: string, team: string, rootId: string | null, taskId: string | null = null): Promise<string> =>
  sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, reply_root_id, task_id, status)
           VALUES ($1, $2, $3, 'mention', $4, $5, $6, 'running') RETURNING id`,
          [WS, bot, team, nadia.actorId, rootId, taskId],
        )
      ).rows[0]!.id,
  );
const goalRows = (thread: string) => sys(async (tx) => (await tx.query<{ id: string; number: number; team_id: string; channel_id: string }>('SELECT id, number, team_id, channel_id FROM app.goals WHERE thread_root_id = $1', [thread])).rows);

let me: Awaited<ReturnType<typeof makeBot>>;
let coder: Awaited<ReturnType<typeof makeBot>>;
let reviewer: Awaited<ReturnType<typeof makeBot>>;
let foreign: Awaited<ReturnType<typeof makeBot>>;
let engCh = '';

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  const ctx = {
    capabilities: { register: (n: string, fn: Handler) => handlers.set(n, fn) },
    db: { getOneOrCreate: (tx: PluginTx, input: never) => getOneOrCreate(tx as unknown as Tx, input) },
    audit: { emit: async (_tx: PluginTx, e: Record<string, unknown>) => void events.push(e) },
  } as unknown as PluginContext;
  registerGoalCapabilities(ctx);
  me = await makeBot(ENG, 'Engineer');
  coder = await makeBot(ENG, 'Coder Bot');
  reviewer = await makeBot(ENG, 'Code Reviewer');
  foreign = await makeBot(SUPPORT, 'Support Bot');
  engCh = await channel(ENG);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('goals.ensure', () => {
  it('makes the goal of the run\'s thread, and gives the same goal to a restarted run and to a run under a reply', async () => {
    const root = await message(engCh, nadia.actorId);
    const reply = await message(engCh, nadia.actorId, root);
    events.length = 0;
    const first = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: 'Ship the jump button', budgetUsd: 15 });
    expect(first['ok'], JSON.stringify(first)).toBe(true);
    expect(first).toMatchObject({ created: true, ref: `G-${first['number']}` });
    const again = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: 'A different title' });
    const underReply = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, reply), { title: 'Another' });
    expect(again).toMatchObject({ ok: true, created: false, goalId: first['goalId'], number: first['number'] });
    expect(underReply).toMatchObject({ ok: true, created: false, goalId: first['goalId'] });
    const rows = await goalRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ team_id: ENG, channel_id: engCh });
    const stored = await sys(async (tx) => (await tx.query<{ title: string; budget_usd: string; created_by: string }>('SELECT title, budget_usd, created_by FROM app.goals WHERE id = $1', [first['goalId']])).rows[0]!);
    expect(stored).toMatchObject({ title: 'Ship the jump button', budget_usd: '15.00', created_by: me.actor });
    // one creation, one event; asking again changed nothing
    expect(events.filter((e) => e['type'] === 'tasks.goal.updated')).toEqual([expect.objectContaining({ change: 'created', goalId: first['goalId'], stepCount: 0, actorId: me.actor })]);
  });

  it('settles two runs asking at the same moment on one goal', async () => {
    const root = await message(engCh, nadia.actorId);
    const [a, b] = await Promise.all([
      tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: 'Race' }),
      tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: 'Race' }),
    ]);
    expect(a['ok'], JSON.stringify(a)).toBe(true);
    expect(b['ok'], JSON.stringify(b)).toBe(true);
    expect(a['goalId']).toBe(b['goalId']);
    expect(await goalRows(root)).toHaveLength(1);
  });

  it('numbers goals within each team: the next number of a team follows its last, and teams count apart', async () => {
    const supportBot = foreign;
    const supCh = await channel(SUPPORT);
    const eng: number[] = [];
    const sup: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      eng.push((await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, await message(engCh, nadia.actorId)), { title: `E${String(i)}` }))['number']);
      sup.push((await tool('goals.ensure', supportBot.actor, await openRun(supportBot.bot, SUPPORT, await message(supCh, nadia.actorId)), { title: `S${String(i)}` }))['number']);
    }
    expect(eng[1]).toBe(eng[0]! + 1);
    expect(eng[2]).toBe(eng[0]! + 2);
    expect(sup[1]).toBe(sup[0]! + 1);
    // the same number can exist in both teams, never twice in one
    const dupes = await sys(async (tx) => (await tx.query('SELECT team_id, number FROM app.goals GROUP BY 1, 2 HAVING count(*) > 1')).rows);
    expect(dupes).toEqual([]);
    // the caller cannot choose the number: the one it names is overwritten by the next of the team's counter
    const named = await asBot(me.actor, null, async (tx) =>
      (await tx.query<{ number: number }>('INSERT INTO app.goals (workspace_id, team_id, number, title, created_by) VALUES ($1, $2, 1, $3, $4) RETURNING number', [WS, ENG, 'pushy', me.actor])).rows[0]!.number,
    );
    expect(named).toBe(eng[2]! + 1);
  });

  it('refuses a person, a run with no thread, a direct message, a finished run and a channel of another team', async () => {
    const root = await message(engCh, nadia.actorId);
    const person = await asPerson(nadia.actorId, (tx) => handlers.get('goals.ensure')!({ title: 'x' }, tx as unknown as PluginTx));
    expect(person).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, null), { title: 'x' })).toMatchObject({ ok: false, code: 'no_thread' });
    expect(await tool('goals.ensure', me.actor, null, { title: 'x' })).toMatchObject({ ok: false, code: 'no_thread' });
    const dm = await message(await channel(null, 'dm'), nadia.actorId);
    expect(await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, dm), { title: 'x' })).toMatchObject({ ok: false, code: 'no_thread' });
    const ended = await openRun(me.bot, ENG, root);
    await sys((tx) => tx.query("UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1", [ended]));
    expect(await tool('goals.ensure', me.actor, ended, { title: 'x' })).toMatchObject({ ok: false, code: 'no_thread' });
    const supMsg = await message(await channel(SUPPORT), nadia.actorId);
    expect(await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, supMsg), { title: 'x' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: '' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await goalRows(supMsg)).toHaveLength(0);
  });
});

describe('goals.plan', () => {
  const step = (title: string, bots: string[], extra: Record<string, unknown> = {}) => ({ title, bots, done: `${title} is finished`, ...extra });

  it('sets the steps of the goal, replaces them on the next call, and emits one planned event', async () => {
    const root = await message(engCh, nadia.actorId);
    const g = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: 'Plan me' });
    events.length = 0;
    const out = await tool('goals.plan', me.actor, null, { goalId: g['goalId'], steps: [step('Code', [coder.slug]), step('Review', [reviewer.slug], { cardRef: 'work' })] });
    expect(out).toMatchObject({ ok: true, goalId: g['goalId'], ref: g['ref'], stepCount: 2 });
    const next = await tool('goals.plan', me.actor, null, { goalId: g['goalId'], steps: [step('Only', [coder.slug])] });
    expect(next).toMatchObject({ ok: true, stepCount: 1 });
    const stored = await sys(async (tx) => (await tx.query<{ steps: unknown[] }>('SELECT steps FROM app.goals WHERE id = $1', [g['goalId']])).rows[0]!.steps);
    expect(stored).toEqual([{ title: 'Only', bots: [coder.slug], done: 'Only is finished' }]);
    expect(events.map((e) => [e['type'], e['change'], e['stepCount']])).toEqual([
      ['tasks.goal.updated', 'planned', 2],
      ['tasks.goal.updated', 'planned', 1],
    ]);
  });

  it('refuses a bot of another team, an unknown slug, thirteen steps, no steps, a goal of another team and a closed goal', async () => {
    const g = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, await message(engCh, nadia.actorId)), { title: 'Refusals' });
    const refused = (steps: unknown) => tool('goals.plan', me.actor, null, { goalId: g['goalId'], steps });
    expect(await refused([step('Support', [foreign.slug])])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await refused([step('Nobody', ['no-such-bot'])])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await refused(Array.from({ length: 13 }, (_, i) => step(`S${String(i)}`, [coder.slug])))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await refused([])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await refused([step('Four bots', [coder.slug, reviewer.slug, me.slug, 'x'])])).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await tool('goals.plan', foreign.actor, null, { goalId: g['goalId'], steps: [step('x', [foreign.slug])] })).toMatchObject({ ok: false, code: 'not_found' });
    await sys((tx) => tx.query("UPDATE app.goals SET status = 'done' WHERE id = $1", [g['goalId']]));
    expect(await refused([step('Late', [coder.slug])])).toMatchObject({ ok: false, code: 'conflict' });
    const steps = await sys(async (tx) => (await tx.query<{ steps: unknown[] }>('SELECT steps FROM app.goals WHERE id = $1', [g['goalId']])).rows[0]!.steps);
    expect(steps).toEqual([]);
  });
});

describe('tasks.goal', () => {
  it('answers the plan from the cards and their handoffs, with display names, spend, the thread and no slug', async () => {
    const root = await message(engCh, nadia.actorId);
    const g = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, root), { title: 'Read me', budgetUsd: 12 });
    await tool('goals.plan', me.actor, null, {
      goalId: g['goalId'],
      steps: [
        { title: 'Code', bots: [coder.slug], done: 'written' },
        { title: 'Review', bots: [reviewer.slug], done: 'approved' },
        { title: 'Ship', bots: [coder.slug, reviewer.slug], done: 'shipped' },
      ],
    });
    // the work card: Engineer made it, handed to the coder, then the reviewer, who holds it now
    const card = await sys(async (tx) => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.tasks (workspace_id, team_id, goal_id, title, branch, created_by, owner_id, state, thread_root_id) VALUES ($1, $2, $3, 'Do it', 'b/read', $4, $5, 'in_progress', $6) RETURNING id`,
          [WS, ENG, g['goalId'], me.actor, reviewer.actor, root],
        )
      ).rows[0]!.id;
      for (const [from, to] of [[me.actor, coder.actor], [coder.actor, reviewer.actor]] as const) {
        await tx.query("INSERT INTO app.handoffs (task_id, team_id, from_actor_id, to_actor_id, mode, applied_at) VALUES ($1, $2, $3, $4, 'bot', now())", [id, ENG, from, to]);
      }
      return id;
    });
    // two runs of the goal: one woken by the card, one answering in the thread; a run of nobody's goal costs nothing here
    const r1 = await openRun(coder.bot, ENG, null, card);
    const r2 = await openRun(me.bot, ENG, root);
    const r3 = await openRun(me.bot, ENG, await message(engCh, nadia.actorId));
    await sys(async (tx) => {
      for (const [run, cost] of [[r1, '1.250000'], [r2, '0.400000'], [r3, '9.000000']] as const) {
        await tx.query("INSERT INTO app.llm_spend (workspace_id, run_id, alias, cost_usd) VALUES ($1, $2, 'smart', $3)", [WS, run, cost]);
      }
    });
    await message(engCh, coder.actor, root);
    await message(engCh, reviewer.actor, root);

    const out = await tool('tasks.goal', me.actor, null, { goalId: g['goalId'] });
    expect(out['ok'], JSON.stringify(out)).toBe(true);
    const plan = out['plan'];
    expect(plan).toMatchObject({
      ref: g['ref'],
      title: 'Read me',
      chip: 'running',
      spend: { usd: 1.65, budgetUsd: 12 },
      stepNow: 2,
      stepCount: 3,
      steps: [
        { title: 'Code', bots: ['Coder Bot'], status: 'done', dot: 'done', rework: 0 },
        { title: 'Review', bots: ['Code Reviewer'], status: 'running', dot: 'running', rework: 0 },
        { title: 'Ship', bots: ['Coder Bot', 'Code Reviewer'], status: '', dot: 'todo', rework: 0 },
      ],
    });
    expect(plan.thread).toMatchObject({ rootId: root, replies: 2, lastName: 'Code Reviewer', faces: ['Code Reviewer', 'Coder Bot'] });
    expect(JSON.stringify(plan)).not.toContain(coder.slug);
    // no board was made for this channel, and the card is on none
    expect(plan.board).toBeNull();
  });

  it('is refused for a goal that is not there, and answers the same to a person of the team', async () => {
    expect(await tool('tasks.goal', me.actor, null, { goalId: randomUUID() })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await tool('tasks.goal', me.actor, null, { goalId: 'nope' })).toMatchObject({ ok: false, code: 'invalid_input' });
    const g = await tool('goals.ensure', me.actor, await openRun(me.bot, ENG, await message(engCh, nadia.actorId)), { title: 'Person reads' });
    const asNadia = await asPerson(nadia.actorId, (tx) => handlers.get('tasks.goal')!({ goalId: g['goalId'] }, tx as unknown as PluginTx));
    expect(asNadia).toMatchObject({ ok: true, plan: { ref: g['ref'], chip: 'planned', stepCount: 0, steps: [] } });
  });
});
