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
import { DEFAULT_PAUSE_MS, MAX_PAUSE_MS, pauseEnd, pauseRunner, recordUsage, reportPodState, resolveRunner } from '../src/resolve.ts';
import { markServed, oneTeam, storeTeamSignIn, teamSignIns } from '../src/team-signins.ts';

// P19-07: a shared Claude Code runner in resolveRunner (the team list is the permission, a refusal is judged before anything is started), usage per team, and the pause.

const { omar } = personas;
let db: TestDatabase;
let sysPool: pg.Pool;
let ctx: PluginContext;
const emitted: Array<Record<string, unknown>> = [];
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
// the pod of a (runner, team): the address and the key are that pod's own (P26-21)
const pods: Pick<ClaudePodsProvider, 'bridge'> = { bridge: async ({ runnerName, teamSlug }) => ({ address: `http://claude-${runnerName}-${teamSlug}.bots.svc:8650`, key: `bridge-key-${teamSlug}` }) };

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
    runtime: { now: () => new Date() },
  } as unknown as PluginContext;
  await make('claude-shared', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
}, 120_000);
afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('resolveRunner for a Claude Code runner', () => {
  it('answers a team on the list with the bridge address and key, no guard, and the team-and-bot profile rule', async () => {
    // each team's run goes to the pod of its own team on the shared runner (one pod per runner and team)
    for (const [team, slug] of [[TEAM_IDS.Engineering, 'engineering'], [TEAM_IDS.Marketing, 'marketing']] as const) {
      expect(await resolve('claude-shared', team)).toMatchObject({
        ok: true,
        target: { runner: 'claude-shared', kind: 'claude_cli', address: `http://claude-claude-shared-${slug}.bots.svc:8650`, key: `bridge-key-${slug}`, agent: 'claude-code', guard: false, profileRule: '{team}--{bot}', status: 'ready' },
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

describe('resolveRunner for a runner where each team signs in (P35-10)', () => {
  it("runs a team only on its own stored sign-in, refuses a team that has not signed in in the plan's sentence, and never falls back to another team's or a shared sign-in", async () => {
    const id = await make('claude-each', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
    await sys((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team' WHERE id = $1::uuid`, [id]));
    await sys((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_in'), ($1, $3, 'signed_out')`, [id, TEAM_IDS.Engineering, TEAM_IDS.Marketing]));
    expect(await resolve('claude-each', TEAM_IDS.Engineering)).toMatchObject({ ok: true, target: { kind: 'claude_cli', address: 'http://claude-claude-each-engineering.bots.svc:8650' } });
    const refused = await resolve('claude-each', TEAM_IDS.Marketing);
    expect(refused).toEqual({ ok: false, reason: 'not_ready', message: 'Team Marketing has not signed in to Claude Code on runner Label of claude-each yet. An admin can sign it in on the Runners page.' });
    // no stored state at all is the same as signed out
    await sys((tx) => tx.query('DELETE FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid AND team_id = $2::uuid', [id, TEAM_IDS.Marketing]));
    expect(await resolve('claude-each', TEAM_IDS.Marketing)).toMatchObject({ ok: false, reason: 'not_ready' });
    // the team list is still judged first, in words that name nothing
    expect(await resolve('claude-each', TEAM_IDS['Customer support'])).toMatchObject({ ok: false, reason: 'not_available_to_team' });
  });

  it('stores what the pod controller reports per team only for a per-team runner, and forgets a team that left the list', async () => {
    const id = await make('claude-each-report', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
    const states = () => sys(async (tx) => (await tx.query<{ team_id: string; state: string }>('SELECT team_id, state FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid ORDER BY team_id', [id])).rows);
    const report = (teams: { teamId: string; state: 'signed_in' | 'signed_out' }[]) => reportPodState(ctx, { runnerId: id, status: 'ready', detail: null, teams });
    // a shared runner keeps no team states, whatever a late report says
    await report([{ teamId: TEAM_IDS.Engineering, state: 'signed_in' }]);
    expect(await states()).toEqual([]);
    await sys((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team' WHERE id = $1::uuid`, [id]));
    // a placeholder id and a team of another workspace are not stored
    await report([{ teamId: TEAM_IDS.Engineering, state: 'signed_in' }, { teamId: TEAM_IDS.Marketing, state: 'signed_out' }, { teamId: 'none', state: 'signed_in' }]);
    expect(await states()).toEqual([{ team_id: TEAM_IDS.Engineering, state: 'signed_in' }, { team_id: TEAM_IDS.Marketing, state: 'signed_out' }].sort((a, b) => a.team_id.localeCompare(b.team_id)));
    await sys((tx) => tx.query('DELETE FROM app.bot_runner_teams WHERE runner_id = $1::uuid AND team_id = $2::uuid', [id, TEAM_IDS.Marketing]));
    await report([{ teamId: TEAM_IDS.Engineering, state: 'signed_out' }]);
    expect(await states()).toEqual([{ team_id: TEAM_IDS.Engineering, state: 'signed_out' }]);
  });

  it("a team's plan limit holds only that team's runs until it resets; the other teams and the runner go on", async () => {
    const id = await make('claude-each-limit', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
    await sys((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team' WHERE id = $1::uuid`, [id]));
    await sys((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_in'), ($1, $3, 'signed_in')`, [id, TEAM_IDS.Engineering, TEAM_IDS.Marketing]));
    const until = new Date(Date.now() + 2 * 3600_000).toISOString();
    await pauseRunner(ctx, { runner: 'claude-each-limit', teamId: TEAM_IDS.Engineering, reason: 'plan_limit', until });
    expect((await sys((tx) => tx.query<{ status: string }>('SELECT status FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0]!.status).toBe('ready');
    const held = await resolve('claude-each-limit', TEAM_IDS.Engineering);
    expect(held).toEqual({ ok: false, reason: 'not_ready', message: `Team Engineering reached the limit of its Claude plan on runner Label of claude-each-limit. Its runs wait until ${until.slice(11, 16)} UTC.` });
    expect(await resolve('claude-each-limit', TEAM_IDS.Marketing)).toMatchObject({ ok: true });
    // the controller's pass does not end the limit early
    await reportPodState(ctx, { runnerId: id, status: 'ready', detail: null, teams: [{ teamId: TEAM_IDS.Engineering, state: 'signed_in' }] });
    expect((await resolve('claude-each-limit', TEAM_IDS.Engineering)).ok).toBe(false);
    // once the reset time has passed the team runs again
    await sys((tx) => tx.query(`UPDATE app.bot_runner_team_signins SET paused_until = now() - interval '1 minute' WHERE runner_id = $1::uuid AND team_id = $2::uuid`, [id, TEAM_IDS.Engineering]));
    expect(await resolve('claude-each-limit', TEAM_IDS.Engineering)).toMatchObject({ ok: true });
  });

  it("a team's refused sign-in is stored as refused: the controller's pass may not undo it, only a real sign-in does, and the other team keeps running", async () => {
    const id = await make('claude-each-refused', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] });
    await sys((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team' WHERE id = $1::uuid`, [id]));
    await sys((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_in'), ($1, $3, 'signed_in')`, [id, TEAM_IDS.Engineering, TEAM_IDS.Marketing]));
    await pauseRunner(ctx, { runner: 'claude-each-refused', teamId: TEAM_IDS.Marketing, reason: 'needs_sign_in', until: null });
    const stateOf = async (team: string) => (await sys((tx) => tx.query<{ state: string }>('SELECT state FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid AND team_id = $2::uuid', [id, team]))).rows[0]?.state;
    expect(await stateOf(TEAM_IDS.Marketing)).toBe('refused');
    // the pod still reads its old file as signed in: the pass says so, and the refusal stays
    await reportPodState(ctx, { runnerId: id, status: 'ready', detail: null, teams: [{ teamId: TEAM_IDS.Marketing, state: 'signed_in' }] });
    expect(await stateOf(TEAM_IDS.Marketing)).toBe('refused');
    expect(await resolve('claude-each-refused', TEAM_IDS.Marketing)).toMatchObject({ ok: false, reason: 'not_ready' });
    expect(await resolve('claude-each-refused', TEAM_IDS.Engineering)).toMatchObject({ ok: true });
    expect((await sys((tx) => tx.query<{ status: string }>('SELECT status FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0]!.status).toBe('ready');
    // a real sign-in on the page (force) clears it
    await sys((tx) => storeTeamSignIn(tx, id, TEAM_IDS.Marketing, 'signed_in', { force: true }));
    expect(await stateOf(TEAM_IDS.Marketing)).toBe('signed_in');
  });

  it("is ready while a stored team is signed in even when that team's pod did not answer this pass, and runs that team while the runner reads waiting", async () => {
    const id = await make('claude-each-slow', { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing], status: 'ready' });
    await sys((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team' WHERE id = $1::uuid`, [id]));
    await sys((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_in')`, [id, TEAM_IDS.Engineering]));
    const status = async () => (await sys((tx) => tx.query<{ status: string }>('SELECT status FROM app.bot_runners WHERE id = $1::uuid', [id]))).rows[0]!.status;
    // engineering's pod is restarting (no answer); marketing's pod says signed out: the controller alone would say waiting
    await reportPodState(ctx, { runnerId: id, status: 'waiting_for_sign_in', detail: 'Waiting for a sign-in.', teams: [{ teamId: TEAM_IDS.Marketing, state: 'signed_out' }] });
    expect(await status()).toBe('ready');
    // with no stored sign-in at all it waits
    await sys((tx) => tx.query(`DELETE FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid AND team_id = $2::uuid`, [id, TEAM_IDS.Engineering]));
    await reportPodState(ctx, { runnerId: id, status: 'waiting_for_sign_in', detail: 'Waiting for a sign-in.', teams: [] });
    expect(await status()).toBe('waiting_for_sign_in');
    // a runner-level sign-in state never refuses a team that is signed in
    await sys((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_in')`, [id, TEAM_IDS.Engineering]));
    expect(await resolve('claude-each-slow', TEAM_IDS.Engineering)).toMatchObject({ ok: true });
    // what is about the pods themselves still is
    await sys((tx) => tx.query(`UPDATE app.bot_runners SET status = 'moving' WHERE id = $1::uuid`, [id]));
    expect(await resolve('claude-each-slow', TEAM_IDS.Engineering)).toMatchObject({ ok: false, reason: 'not_ready' });
  });

  it('serves the first team in code-unit order, the same rule as the pod controller, whatever the database collation says', async () => {
    const [a, b] = await sys(async (tx) => {
      const mk = async (slug: string) =>
        (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, $2, $3) RETURNING id`, [omar.workspaceId, slug, `Team ${slug}`])).rows[0]!.id;
      // byte order: "a-z" < "ab" ('-' is 0x2d); a locale that ignores punctuation reads "az" > "ab"
      return [await mk('ab'), await mk('a-z')];
    });
    const id = await make('claude-each-order', { teams: [a!, b!] });
    const teams = await sys((tx) => teamSignIns(tx, { id }));
    expect(teams.map((t) => [t.slug, t.served])).toEqual([
      ['a-z', true],
      ['ab', false],
    ]);
    expect((await sys((tx) => oneTeam(tx, id, 'a-z')))?.served).toBe(true);
    expect((await sys((tx) => oneTeam(tx, id, 'ab')))?.served).toBe(false);
    expect(markServed([{ slug: 'ab', hasBot: false }, { slug: 'a-z', hasBot: false }]).map((t) => t.slug)).toEqual(['a-z', 'ab']);
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

describe('how long a plan-limit pause lasts', () => {
  const now = Date.parse('2026-11-06T10:00:00.000Z');
  it('takes the reset time, or a short default when there is none, it is past, or it is not a date', () => {
    expect(pauseEnd('2026-11-06T12:00:00.000Z', now)).toBe('2026-11-06T12:00:00.000Z');
    expect(Date.parse(pauseEnd(null, now)) - now).toBe(DEFAULT_PAUSE_MS);
    expect(Date.parse(pauseEnd('2026-11-06T09:00:00.000Z', now)) - now).toBe(DEFAULT_PAUSE_MS);
    expect(Date.parse(pauseEnd('nonsense', now)) - now).toBe(DEFAULT_PAUSE_MS);
  });
  it('never trusts a far-off date', () => {
    expect(Date.parse(pauseEnd('2033-01-01T00:00:00.000Z', now)) - now).toBe(MAX_PAUSE_MS);
  });
});
