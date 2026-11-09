import { createSystemPool, getSecret, withSystem, type Tx } from '@manythreads/kernel';
import type { ClaudePodsProvider, PluginContext } from '@manythreads/sdk';
import {
  botRunnersMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personas,
  runtimeHermesMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pauseRunner, podRunners, recordUsage, reportPodState, resolveRunner } from '../src/resolve.ts';

// P19-13: a Codex runner in resolveRunner (agent `codex`, the same team-list rule, the same refusals), usage per team, the plan-limit pause with Codex's own event, and the pod state.
// Modelled on claude-runner.test.ts; the pod provider is a stub that records what it was asked.

const { omar } = personas;
let db: TestDatabase;
let sysPool: pg.Pool;
let ctx: PluginContext;
const emitted: Array<Record<string, unknown>> = [];
const asked: Array<{ runnerName: string; agent?: string }> = [];
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const pods: Pick<ClaudePodsProvider, 'bridge'> = {
  bridge: async (q) => {
    asked.push(q);
    return { address: `http://${q.agent === 'codex' ? 'codex' : 'claude'}-${q.runnerName}.bots.svc:8650`, key: 'bridge-key-0123456789' };
  },
};

const make = (name: string, over: { kind?: string; enabled?: boolean; status?: string; teams?: string[]; pausedUntil?: string | null } = {}): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, all_teams, status, paused_until) VALUES ($1, $2, $3, $4, $5, false, $6, $7) RETURNING id`,
        [omar.workspaceId, name, `Label of ${name}`, over.kind ?? 'codex_cli', over.enabled ?? true, over.status ?? 'ready', over.pausedUntil ?? null],
      )
    ).rows[0]!.id;
    for (const t of over.teams ?? []) await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1, $2)', [id, t]);
    return id;
  });
const resolve = (runner: string, teamId: string = TEAM_IDS.Engineering) => resolveRunner(ctx, { teamId, runner });
const rowOf = async (name: string) => (await sys((tx) => tx.query<{ status: string; status_detail: string; paused_until: string | null }>('SELECT status, status_detail, paused_until FROM app.bot_runners WHERE name = $1', [name]))).rows[0]!;

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, runtimeHermesMigrationSource, botRunnersMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  ctx = {
    db: { system: (fn: (tx: Tx) => Promise<unknown>, options?: { workspaceId?: string }) => withSystem(fn, { pool: sysPool, workspaceId: (options?.workspaceId ?? omar.workspaceId) as never }) },
    secrets: { get: (tx: Tx, id: string) => getSecret(tx, id) },
    providers: { get: (id: string) => (id === 'claude.pods' ? pods : undefined) },
    audit: { emit: async (_tx: unknown, e: Record<string, unknown>) => void emitted.push(e) },
    runtime: { now: () => new Date() },
  } as unknown as PluginContext;
  await make('codex-shared', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
  await make('claude-one', { kind: 'claude_cli', teams: [TEAM_IDS.Engineering] });
}, 120_000);
afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('resolveRunner for a Codex runner', () => {
  it('answers a team on the list with the Codex pod address, agent codex, no guard and the team-and-bot profile rule; the pod is asked for Codex', async () => {
    for (const team of [TEAM_IDS.Engineering, TEAM_IDS.Marketing]) {
      expect(await resolve('codex-shared', team)).toMatchObject({
        ok: true,
        target: { runner: 'codex-shared', kind: 'codex_cli', address: 'http://codex-codex-shared.bots.svc:8650', key: 'bridge-key-0123456789', agent: 'codex', guard: false, profileRule: '{team}--{bot}', status: 'ready' },
      });
    }
    expect(asked.at(-1)).toEqual({ runnerName: 'codex-shared', agent: 'codex' });
    // and a Claude runner is still asked for Claude, so the pod picks the right Secret and address
    expect(await resolve('claude-one')).toMatchObject({ ok: true, target: { kind: 'claude_cli', agent: 'claude-code' } });
    expect(asked.at(-1)).toEqual({ runnerName: 'claude-one', agent: 'claude' });
  });

  it('refuses a team that is not on the list in words that name nothing', async () => {
    const answer = await resolve('codex-shared', TEAM_IDS['Customer support']);
    expect(answer).toMatchObject({ ok: false, reason: 'not_available_to_team' });
    expect(JSON.stringify(answer)).not.toMatch(/bridge-key|codex-codex|svc/);
  });

  it('refuses every state a runner cannot serve, in a plain sentence', async () => {
    const cases: Array<[string, { status?: string; enabled?: boolean }, RegExp]> = [
      ['x-wait', { status: 'waiting_for_sign_in' }, /waiting for a sign-in/],
      ['x-needs', { status: 'needs_sign_in' }, /needing a new sign-in/],
      ['x-starting', { status: 'starting' }, /still starting/],
      ['x-off', { enabled: false }, /switched it off|switched off/],
    ];
    for (const [name, over, text] of cases) {
      await make(name, { ...over, teams: [TEAM_IDS.Engineering] });
      const answer = await resolve(name);
      expect(answer.ok, name).toBe(false);
      if (!answer.ok) expect(answer.message, name).toMatch(text);
    }
  });

  it('a paused runner is refused with its time, and serves again once the time has passed', async () => {
    await make('x-paused', { status: 'paused', pausedUntil: new Date(Date.now() + 3600_000).toISOString(), teams: [TEAM_IDS.Engineering] });
    const answer = await resolve('x-paused');
    expect(answer).toMatchObject({ ok: false, reason: 'not_ready' });
    if (!answer.ok) expect(answer.message).toMatch(/paused until \d\d:\d\d UTC/);
    await make('x-expired', { status: 'paused', pausedUntil: new Date(Date.now() - 1000).toISOString(), teams: [TEAM_IDS.Engineering] });
    expect(await resolve('x-expired')).toMatchObject({ ok: true });
  });

  it('is no longer "not runnable": the kind runs bots, and with no pod provider it is "not set up"', async () => {
    await make('x-future', { teams: [TEAM_IDS.Engineering] });
    const bare = { ...ctx, providers: { get: () => undefined } } as unknown as PluginContext;
    expect(await resolveRunner(bare, { teamId: TEAM_IDS.Engineering, runner: 'x-future' })).toMatchObject({ ok: false, reason: 'not_set_up' });
  });
});

describe('the pod controller sees Codex runners', () => {
  it('podRunners lists the runners of the asked kind only', async () => {
    const codex = await podRunners(ctx, { kind: 'codex_cli' });
    const claude = await podRunners(ctx, { kind: 'claude_cli' });
    expect(codex.map((r) => r.name)).toContain('codex-shared');
    expect(codex.map((r) => r.name)).not.toContain('claude-one');
    expect(claude.map((r) => r.name)).toContain('claude-one');
    expect(claude.map((r) => r.name)).not.toContain('codex-shared');
  });

  it('reportPodState moves a Codex runner between the states the pod owns, and leaves a needs-sign-in runner alone', async () => {
    const id = await make('x-state', { status: 'starting' });
    await reportPodState(ctx, { runnerId: id, status: 'ready', detail: 'Ready.' });
    expect(await rowOf('x-state')).toMatchObject({ status: 'ready', status_detail: 'Ready.' });
    await reportPodState(ctx, { runnerId: id, status: 'waiting_for_node', detail: 'Waiting for a machine.' });
    expect((await rowOf('x-state')).status).toBe('waiting_for_node');
    const stuck = await make('x-stuck', { status: 'needs_sign_in' });
    await reportPodState(ctx, { runnerId: stuck, status: 'ready', detail: 'Ready.' });
    expect((await rowOf('x-stuck')).status).toBe('needs_sign_in');
  });
});

describe('usage and the pause for a Codex runner', () => {
  it('adds runs, seconds and cost per runner, team and day', async () => {
    await sys((tx) => tx.query('DELETE FROM app.bot_runner_usage'));
    await recordUsage(ctx, { runner: 'codex-shared', teamId: TEAM_IDS.Engineering, seconds: 12.4, cost: null });
    await recordUsage(ctx, { runner: 'codex-shared', teamId: TEAM_IDS.Engineering, seconds: 30, cost: null });
    await recordUsage(ctx, { runner: 'codex-shared', teamId: TEAM_IDS.Marketing, seconds: 5, cost: null });
    const rows = (await sys((tx) => tx.query<{ team_id: string; runs: number; seconds: number }>('SELECT team_id, runs, seconds FROM app.bot_runner_usage ORDER BY runs DESC'))).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ team_id: TEAM_IDS.Engineering, runs: 2, seconds: 42 });
    expect(rows[1]).toMatchObject({ team_id: TEAM_IDS.Marketing, runs: 1, seconds: 5 });
  });

  it('pauses once at the plan limit with the Codex event and the reset time, then refuses the next run; a refused sign-in marks needs sign-in in Codex words', async () => {
    await make('x-limit', { teams: [TEAM_IDS.Engineering] });
    const until = new Date(Date.now() + 2 * 3600_000).toISOString();
    emitted.length = 0;
    await pauseRunner(ctx, { runner: 'x-limit', teamId: TEAM_IDS.Engineering, reason: 'plan_limit', until });
    await pauseRunner(ctx, { runner: 'x-limit', teamId: TEAM_IDS.Engineering, reason: 'plan_limit', until });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'codex_pod.runner.paused', name: 'x-limit', reason: 'plan_limit', until });
    expect(await resolve('x-limit')).toMatchObject({ ok: false, reason: 'not_ready' });
    await make('x-401', { teams: [TEAM_IDS.Engineering] });
    emitted.length = 0;
    await pauseRunner(ctx, { runner: 'x-401', teamId: TEAM_IDS.Engineering, reason: 'needs_sign_in', until: null });
    const row = await rowOf('x-401');
    expect(row.status).toBe('needs_sign_in');
    expect(row.status_detail).toMatch(/Upload a new sign-in file/);
    expect(row.status_detail).not.toMatch(/Claude/);
    expect(emitted[0]).toMatchObject({ type: 'codex_pod.runner.paused', reason: 'needs_sign_in' });
  });

  it('a Claude runner still gets the Claude event', async () => {
    emitted.length = 0;
    await pauseRunner(ctx, { runner: 'claude-one', teamId: TEAM_IDS.Engineering, reason: 'needs_sign_in', until: null });
    expect(emitted[0]).toMatchObject({ type: 'claude_pod.runner.paused' });
    expect((await rowOf('claude-one')).status_detail).toMatch(/Claude/);
  });
});
