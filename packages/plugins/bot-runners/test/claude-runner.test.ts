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
import { pauseRunner, recordUsage, resolveRunner } from '../src/resolve.ts';

// P19-07: a shared Claude Code runner in resolveRunner (the team list is the permission, a refusal is judged before anything is started), usage per team, and the pause.

const { omar } = personas;
let db: TestDatabase;
let sysPool: pg.Pool;
let ctx: PluginContext;
const emitted: Array<Record<string, unknown>> = [];
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const pods: Pick<ClaudePodsProvider, 'bridge'> = { bridge: async ({ runnerName }) => ({ address: `http://claude-${runnerName}.bots.svc:8650`, key: 'bridge-key-0123456789' }) };
const nowMs = Date.parse('2026-11-06T12:00:00Z');

const make = (name: string, over: { enabled?: boolean; status?: string; teams?: string[]; allTeams?: boolean; pausedUntil?: string | null } = {}): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, all_teams, status, paused_until) VALUES ($1, $2, $3, 'claude_cli', $4, $5, $6, $7) RETURNING id`,
        [omar.workspaceId, name, `Label of ${name}`, over.enabled ?? true, over.allTeams ?? false, over.status ?? 'ready', over.pausedUntil ?? null],
      )
    ).rows[0]!.id;
    for (const t of over.teams ?? []) await tx.query('INSERT INTO app.bot_runner_teams (runner_id, team_id) VALUES ($1, $2)', [id, t]);
    return id;
  });
const resolve = (runner: string, teamId: string = TEAM_IDS.Engineering) => resolveRunner(ctx, { teamId, runner });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, runtimeHermesMigrationSource, botRunnersMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  ctx = {
    db: { system: (fn: (tx: Tx) => Promise<unknown>, options?: { workspaceId?: string }) => withSystem(fn, { pool: sysPool, workspaceId: (options?.workspaceId ?? omar.workspaceId) as never }) },
    secrets: { get: (tx: Tx, id: string) => getSecret(tx, id) },
    providers: { get: (id: string) => (id === 'claude.pods' ? pods : undefined) },
    audit: { emit: async (_tx: unknown, e: Record<string, unknown>) => void emitted.push(e) },
    runtime: { now: () => new Date(nowMs) },
  } as unknown as PluginContext;
  await make('claude-shared', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
}, 120_000);
afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('resolveRunner for a Claude Code runner', () => {
  it('answers a team on the list with the bridge address and key, no guard, and the team-and-bot profile rule', async () => {
    for (const team of [TEAM_IDS.Engineering, TEAM_IDS.Marketing]) {
      expect(await resolve('claude-shared', team)).toMatchObject({
        ok: true,
        target: { runner: 'claude-shared', kind: 'claude_cli', address: 'http://claude-claude-shared.bots.svc:8650', key: 'bridge-key-0123456789', agent: 'claude-code', guard: false, profileRule: '{team}--{bot}', status: 'ready' },
      });
    }
  });

  it('refuses a team that is not on the list in words that name nothing, and starts nothing', async () => {
    const answer = await resolve('claude-shared', TEAM_IDS['Customer support']);
    expect(answer).toMatchObject({ ok: false, reason: 'not_available_to_team' });
    expect(JSON.stringify(answer)).not.toMatch(/bridge-key|claude-claude|svc/);
  });

  it('refuses every state a runner cannot serve, in a plain sentence', async () => {
    const cases: Array<[string, { status?: string; enabled?: boolean }, RegExp]> = [
      ['c-wait', { status: 'waiting_for_sign_in' }, /waiting for a sign-in/],
      ['c-needs', { status: 'needs_sign_in' }, /needing a new sign-in/],
      ['c-starting', { status: 'starting' }, /still starting/],
      ['c-off', { enabled: false }, /switched it off|switched off/],
    ];
    for (const [name, over, text] of cases) {
      await make(name, { ...over, teams: [TEAM_IDS.Engineering] });
      const answer = await resolve(name);
      expect(answer.ok, name).toBe(false);
      if (!answer.ok) expect(answer.message, name).toMatch(text);
    }
  });

  it('a paused runner is refused with its time, and serves again once the time has passed', async () => {
    await make('c-paused', { status: 'paused', pausedUntil: new Date(Date.now() + 3600_000).toISOString(), teams: [TEAM_IDS.Engineering] });
    const answer = await resolve('c-paused');
    expect(answer).toMatchObject({ ok: false, reason: 'not_ready' });
    if (!answer.ok) expect(answer.message).toMatch(/paused until \d\d:\d\d UTC/);
    await make('c-expired', { status: 'paused', pausedUntil: new Date(Date.now() - 1000).toISOString(), teams: [TEAM_IDS.Engineering] });
    expect(await resolve('c-expired')).toMatchObject({ ok: true });
  });
});

describe('usage and the pause', () => {
  it('adds runs, seconds and the CLI cost per runner, team and day', async () => {
    await recordUsage(ctx, { runner: 'claude-shared', teamId: TEAM_IDS.Engineering, seconds: 12.4, cost: 0.25 });
    await recordUsage(ctx, { runner: 'claude-shared', teamId: TEAM_IDS.Engineering, seconds: 30, cost: null });
    await recordUsage(ctx, { runner: 'claude-shared', teamId: TEAM_IDS.Marketing, seconds: 5, cost: 0.1 });
    const rows = (await sys((tx) => tx.query<{ team_id: string; runs: number; seconds: number; cli_cost: string }>('SELECT team_id, runs, seconds, cli_cost::text FROM app.bot_runner_usage ORDER BY runs DESC'))).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ team_id: TEAM_IDS.Engineering, runs: 2, seconds: 42 });
    expect(Number(rows[0]!.cli_cost)).toBeCloseTo(0.25);
    expect(rows[1]).toMatchObject({ team_id: TEAM_IDS.Marketing, runs: 1, seconds: 5 });
  });

  it('ignores a runner that is not a Claude runner of the workspace', async () => {
    await recordUsage(ctx, { runner: 'nothing', teamId: TEAM_IDS.Engineering, seconds: 1, cost: 0 });
    expect((await sys((tx) => tx.query('SELECT 1 FROM app.bot_runner_usage'))).rows).toHaveLength(2);
  });

  it('pauses once at the plan limit with the reset time, then refuses the next run; a refused sign-in marks needs sign-in', async () => {
    await make('c-limit', { teams: [TEAM_IDS.Engineering] });
    const until = new Date(Date.now() + 2 * 3600_000).toISOString();
    emitted.length = 0;
    await pauseRunner(ctx, { runner: 'c-limit', teamId: TEAM_IDS.Engineering, reason: 'plan_limit', until });
    await pauseRunner(ctx, { runner: 'c-limit', teamId: TEAM_IDS.Engineering, reason: 'plan_limit', until });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'claude_pod.runner.paused', name: 'c-limit', reason: 'plan_limit', until });
    expect(await resolve('c-limit')).toMatchObject({ ok: false, reason: 'not_ready' });
    await make('c-401', { teams: [TEAM_IDS.Engineering] });
    await pauseRunner(ctx, { runner: 'c-401', teamId: TEAM_IDS.Engineering, reason: 'needs_sign_in', until: null });
    const row = (await sys((tx) => tx.query<{ status: string; status_detail: string }>("SELECT status, status_detail FROM app.bot_runners WHERE name = 'c-401'"))).rows[0]!;
    expect(row.status).toBe('needs_sign_in');
    expect(row.status_detail).toMatch(/Upload a new sign-in file/);
  });
});
