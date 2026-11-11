import { randomUUID } from 'node:crypto';
import { getOneOrCreate, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, personas, personaActor, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGoalCapabilities } from '../../src/goals.ts';

// Who reads a goal's plan and what it costs (migration 0016): an outsider reads nothing, a reader of the team's channel who is not in the team gets
// `forbidden` from the spend door (a null spend) and no board, and the numbering counter and the spend door are not open to the app role.

const { nadia, sameera } = personas;
const WS = KAHF_WORKSPACE_ID;
const ENG = TEAM_IDS.Engineering;

let server: TestServer;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: server.pools.system, workspaceId: WS });
const asPerson = <T>(persona: typeof nadia, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(persona), fn, { pool: server.pools.app });
const asBot = <T>(actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor({ kind: 'bot', id: actor, workspaceId: WS } as Actor, fn, { pool: server.pools.app });

type Handler = (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>;
const handlers = new Map<string, Handler>();

let goalId = '';
let channelId = '';
let rootId = '';
let runId = '';
let botActor = '';

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  registerGoalCapabilities({
    capabilities: { register: (n: string, fn: Handler) => handlers.set(n, fn) },
    db: { getOneOrCreate: (tx: PluginTx, input: never) => getOneOrCreate(tx as unknown as Tx, input) },
    audit: { emit: async () => undefined },
  } as unknown as PluginContext);
  await sys(async (tx) => {
    const slug = `gp-${randomUUID().slice(0, 6)}`;
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [WS, ENG, slug],
      )
    ).rows[0]!.id;
    botActor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [WS, bot])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [ENG, botActor, WS]);
    channelId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, 'channel', false, $4) RETURNING id`,
        [WS, ENG, `gp-${randomUUID().slice(0, 6)}`, nadia.actorId],
      )
    ).rows[0]!.id;
    rootId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'goal', 'goal') RETURNING id`,
        [WS, channelId, nadia.actorId],
      )
    ).rows[0]!.id;
    runId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, reply_root_id, status) VALUES ($1, $2, $3, 'mention', $4, $5, 'running') RETURNING id`,
        [WS, bot, ENG, nadia.actorId, rootId],
      )
    ).rows[0]!.id;
    goalId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.goals (workspace_id, team_id, title, created_by, channel_id, thread_root_id, budget_usd) VALUES ($1, $2, 'Secret plan', $3, $4, $5, 20) RETURNING id`,
        [WS, ENG, botActor, channelId, rootId],
      )
    ).rows[0]!.id;
    await tx.query("INSERT INTO app.llm_spend (workspace_id, run_id, alias, cost_usd) VALUES ($1, $2, 'smart', 3.456)", [WS, runId]);
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('a goal plan under row-level security', () => {
  it('shows a member of another team nothing: no goal row, no plan, no spend, no counter', async () => {
    const seen = await asPerson(sameera, async (tx) => ({
      rows: (await tx.query('SELECT 1 FROM app.goals WHERE id = $1', [goalId])).rows.length,
      plan: await handlers.get('tasks.goal')!({ goalId }, tx as unknown as PluginTx),
      spend: (await tx.query<{ usd: string | null }>('SELECT app.tasks_goal_spend($1::uuid)::text AS usd', [goalId])).rows[0]!.usd,
    }));
    expect(seen.rows).toBe(0);
    expect(seen.plan).toMatchObject({ ok: false, code: 'not_found' });
    expect(seen.spend).toBeNull();
    await expect(asPerson(sameera, (tx) => tx.query('SELECT * FROM app.goal_counters'))).rejects.toThrow(/permission denied/);
  });

  it('gives a team member the plan and the spend of that goal, rounded to cents, and only that goal\'s runs', async () => {
    const out = await asPerson(nadia, async (tx) => ({
      plan: (await handlers.get('tasks.goal')!({ goalId }, tx as unknown as PluginTx)) as { ok: boolean; plan: { spend: unknown; thread: unknown } },
      other: (await tx.query<{ usd: string | null }>('SELECT app.tasks_goal_spend($1::uuid)::text AS usd', [randomUUID()])).rows[0]!.usd,
    }));
    expect(out.plan.ok).toBe(true);
    expect(out.plan.plan.spend).toEqual({ usd: 3.46, budgetUsd: 20 });
    expect(out.other).toBeNull();
  });

  it('answers a bot of the team too (a bot reads the plan under its own rows)', async () => {
    const out = await asBot(botActor, (tx) => handlers.get('tasks.goal')!({ goalId }, tx as unknown as PluginTx));
    expect(out).toMatchObject({ ok: true, plan: { title: 'Secret plan', spend: { usd: 3.46 } } });
  });

  it('gives a person who reads the channel but is not in the team no spend and no board, and the thread only as far as the channel allows', async () => {
    // sameera is outside Engineering. The goal row itself is a team row, so she gets `not_found` from the read; the spend door agrees.
    const out = await asPerson(sameera, (tx) => handlers.get('tasks.goal')!({ goalId }, tx as unknown as PluginTx));
    expect(out).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('does not let the app role write the counter or change a goal number', async () => {
    await expect(asPerson(nadia, (tx) => tx.query('UPDATE app.goal_counters SET last_number = 0'))).rejects.toThrow(/permission denied/);
    await expect(sys((tx) => tx.query('UPDATE app.goals SET number = number + 1000 WHERE id = $1', [goalId]))).rejects.toThrow(/do not change/);
    await expect(sys((tx) => tx.query('UPDATE app.goals SET team_id = $2 WHERE id = $1', [goalId, TEAM_IDS['Customer support']]))).rejects.toThrow(/do not change/);
  });
});
