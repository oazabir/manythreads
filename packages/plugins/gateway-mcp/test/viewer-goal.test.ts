import { createAppPool, withActor, type Actor } from '@manythreads/kernel';
import type { McpToolsProvider, PluginTx } from '@manythreads/sdk';
import { TasksGoalAnswer, bindableTool } from '@manythreads/shared';
import { personaActor } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// A screen may bind `tasks.goal` (PLAN P22-03, the plan card): the gateway's door for a person's read runs it as the person looking. A person of the goal's team
// reads the plan; a person who cannot read the team gets nothing; a bot's transaction (or the system role) is refused at the door. Real server, real database.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: World;
let appPool: pg.Pool;
let provider: McpToolsProvider;
let engineering = '';
let botActor = '';
let goalId = '';
let goalNumber = 0;
const WS = omar.workspaceId;

const asPerson = <T>(who: (typeof personas)[keyof typeof personas], fn: (tx: PluginTx) => Promise<T>): Promise<T> =>
  withActor(personaActor(who) as Actor, (tx) => fn(tx as unknown as PluginTx), { pool: appPool });

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  appPool = createAppPool(w.server.db.appUrl, 4);
  engineering = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  const seeded = await w.system(async (tx) => {
    const g = await tx.query<{ id: string; number: number }>(
      "INSERT INTO app.goals (workspace_id, team_id, title, created_by, budget_usd) VALUES ($1, $2, 'Ship the jump button', $3, 15) RETURNING id, number",
      [WS, engineering, nadia.actorId],
    );
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
       VALUES ($1, $2, 'goal-reader', 'goal-reader', '', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runner": "default"}') RETURNING id`,
      [WS, engineering],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, b.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [engineering, a.rows[0]!.id, WS]);
    return { goal: g.rows[0]!, actor: a.rows[0]!.id };
  });
  goalId = seeded.goal.id;
  goalNumber = seeded.goal.number;
  botActor = seeded.actor;
  provider = w.server.host.registries.providers['mcp.tools']!.list()[0]!.value as McpToolsProvider;
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await w?.close();
});

describe('a screen reads tasks.goal as the person looking', () => {
  it('is on the list of bindable tools with a goal id and nothing else', () => {
    const tool = bindableTool('tasks.goal');
    expect(tool).toBeDefined();
    expect(tool!.args.safeParse({ goalId }).success).toBe(true);
    expect(tool!.args.safeParse({}).success).toBe(false);
    expect(tool!.args.safeParse({ goalId: 'not-a-uuid' }).success).toBe(false);
    expect(tool!.args.safeParse({ goalId, teamId: engineering }).success).toBe(false);
  });

  it('a person of the goal’s team reads the plan', async () => {
    const out = await asPerson(nadia, (tx) => provider.readForViewer(tx, 'tasks.goal', { goalId }));
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    if (!out.ok) return;
    const answer = TasksGoalAnswer.parse(out.data);
    expect(answer.plan).toMatchObject({ ref: `G-${goalNumber}`, title: 'Ship the jump button', stepCount: 0 });
  });

  it('a person who cannot read the team gets no plan: the call is hers, not the bot’s', async () => {
    const out = await asPerson(sameera, (tx) => provider.readForViewer(tx, 'tasks.goal', { goalId }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.stringify(out.data)).not.toContain('Ship the jump button');
  });

  it('refuses a bot’s transaction and the system role, even for a bot on the goal’s team', async () => {
    const asBot = await withActor({ kind: 'bot', id: botActor as never, workspaceId: WS as never }, (tx) => provider.readForViewer(tx as unknown as PluginTx, 'tasks.goal', { goalId }), {
      pool: appPool,
    });
    expect(asBot).toMatchObject({ ok: false, code: 'forbidden' });
    const asSystem = await w.system((tx) => provider.readForViewer(tx as unknown as PluginTx, 'tasks.goal', { goalId }));
    expect(asSystem).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('refuses arguments that do not fit', async () => {
    expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, 'tasks.goal', {}))).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, 'tasks.goal', { goalId: 'nope' }))).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(await asPerson(nadia, (tx) => provider.readForViewer(tx, 'tasks.goal', { goalId, extra: 1 }))).toMatchObject({ ok: false, code: 'invalid_args' });
  });
});
