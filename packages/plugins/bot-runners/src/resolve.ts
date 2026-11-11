import type { BotRunnersProvider, ClaudePodsProvider, PluginContext, PluginTx, PodRunnerInfo, PodRunnerState, RunnerPlacementCheck, RunnerResolution, RunnerTarget, TeamRunnerInfo } from '@manythreads/sdk';
import { BotRunnerName, modelRunnerProblem } from '@manythreads/shared';
import { effectiveStatus, RUNNER_SELECT, type RunnerRow } from './rows.ts';

// `resolveRunner`: the one place that turns a runner's NAME into where a run goes (PLAN P19-02). A connection, a team pod and a runner all answer "where does
// this bot's run go?"; runtime-hermes asks here for every runner and for every connection an admin has adopted, so two lookups cannot disagree.
//
// It runs as the system actor, because it is the only reader of a Hermes gateway's key. What it returns never leaves the server: a BOT.md, a bot API answer
// and a log carry the name only. The refusals are plain sentences safe to post in a thread; none of them holds an address, a key or a node.

export const DEFAULT_PROFILE_RULE = '{bot}';
/** The bridge's profile of a bot in a shared Claude or Codex pod: `<team>--<bot>`. `{team}` is filled in by runtime-hermes. */
export const CLAUDE_PROFILE_RULE = '{team}--{bot}';

const refuse = (reason: Extract<RunnerResolution, { ok: false }>['reason'], message: string): RunnerResolution => ({ ok: false, reason, message });

/** The name as a sentence may carry it: only what the name rule allows, so a hostile BOT.md cannot put text into a message by way of it. */
const shown = (name: string): string => (BotRunnerName.safeParse(name).success ? `"${name}"` : 'that name');

/** The kinds that run a bot. A kind not on this list is listed to admins and teams but answers `not_runnable`. */
const RUNNABLE_KINDS: ReadonlySet<string> = new Set(['hermes_gateway', 'hermes_pod', 'llm_gateway', 'claude_cli', 'codex_cli']);

/**
 * The states in which a runner turns a run away, in the words a thread may carry. `ready` runs; so does `not_set_up` when the runner has an address and a key (an admin changed
 * something and has not pressed Test yet; a bot that worked a minute ago keeps working). Every other state cannot serve a run.
 */
const UNREADY_STATES: Readonly<Record<string, string>> = {
  waiting_for_sign_in: 'waiting for a sign-in',
  starting: 'still starting',
  needs_sign_in: 'needing a new sign-in',
  waiting_for_node: 'waiting for its machine',
  moving: 'being moved',
  paused: 'paused',
};

/** Is the runner open to the team: every team, or the team is on its list. The list is the permission. */
async function openToTeam(tx: PluginTx, runner: { id: string; all_teams: boolean }, teamId: string): Promise<boolean> {
  if (runner.all_teams) return true;
  return (await tx.query('SELECT 1 FROM app.bot_runner_teams WHERE runner_id = $1::uuid AND team_id = $2::uuid', [runner.id, teamId])).rows.length > 0;
}

export async function resolveRunner(ctx: PluginContext, query: { teamId: string; runner: string }): Promise<RunnerResolution> {
  return ctx.db.system(async (tx) => {
    const team = (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.teams WHERE id = $1::uuid', [query.teamId])).rows[0];
    if (!team) return refuse('unknown', `This bot's team could not be found, so its runner ${shown(query.runner)} cannot be used.`);
    const runner = (
      await tx.query<RunnerRow>(`SELECT ${RUNNER_SELECT} WHERE r.workspace_id = $1::uuid AND r.name = $2`, [team.workspace_id, query.runner])
    ).rows[0];
    if (!runner) return refuse('unknown', `This bot runs on a runner called ${shown(query.runner)}, which does not exist. An admin may have removed it.`);
    // The team's list is judged first, and in words that do not name the runner: a team that is not on the list learns nothing about it, not even that it exists or is off.
    if (!(await openToTeam(tx, runner, query.teamId))) return refuse('not_available_to_team', 'This bot runs on a runner this team may not use. An admin can add the team to its list.');
    if (!runner.enabled) return refuse('disabled', `This bot runs on ${runner.label}, which an admin has switched off.`);
    if (!RUNNABLE_KINDS.has(runner.kind)) return refuse('not_runnable', `This bot runs on ${runner.label}, which cannot run bots yet.`);
    const status = effectiveStatus(runner);
    const unready = UNREADY_STATES[status];
    if (unready !== undefined) {
      const until = status === 'paused' && runner.paused_until !== null ? ` until ${runner.paused_until.toISOString().slice(11, 16)} UTC` : '';
      return refuse('not_ready', `This bot runs on ${runner.label}, which is not ready: it is ${unready}${until}.`);
    }
    const base = { runner: runner.name, label: runner.label, status, profileRule: runner.profile_rule ?? DEFAULT_PROFILE_RULE, modelAlias: null } as const;

    if (runner.kind === 'hermes_gateway') {
      if (runner.base_url === null || runner.secret_id === null) return refuse('not_set_up', `This bot runs on ${runner.label}, which is not set up yet. An admin has to give it an address and a key.`);
      const key = await ctx.secrets.get(tx, runner.secret_id);
      const target: RunnerTarget = { ...base, kind: 'hermes_gateway', address: runner.base_url, key, agent: runner.agent, guard: true };
      return { ok: true, target };
    }
    // A Claude Code runner is one pod for every team on its list (shared mode, spec section 10.3): the address is its Service and the key its bridge key, which only this resolver reads. No outbound
    // guard: nobody types this address. The team list was judged above, so a trigger of any kind (a person, a mention, a hand-off, a routine) is allowed for a team on it.
    if (runner.kind === 'claude_cli') {
      const bridge = await ctx.providers.get<ClaudePodsProvider>('claude.pods')?.bridge({ runnerName: runner.name, agent: 'claude' }).catch(() => null);
      if (!bridge) return refuse('not_set_up', `This bot runs on ${runner.label}, which is not running yet.`);
      const target: RunnerTarget = { ...base, kind: 'claude_cli', address: bridge.address, key: bridge.key, agent: 'claude-code', guard: false, profileRule: runner.profile_rule ?? CLAUDE_PROFILE_RULE };
      return { ok: true, target };
    }
    // A Codex runner is the same shape: one pod for every team on its list, answered by the same agent bridge with a `codex` profile.
    if (runner.kind === 'codex_cli') {
      const bridge = await ctx.providers.get<ClaudePodsProvider>('claude.pods')?.bridge({ runnerName: runner.name, agent: 'codex' }).catch(() => null);
      if (!bridge) return refuse('not_set_up', `This bot runs on ${runner.label}, which is not running yet.`);
      const target: RunnerTarget = { ...base, kind: 'codex_cli', address: bridge.address, key: bridge.key, agent: 'codex', guard: false, profileRule: runner.profile_rule ?? CLAUDE_PROFILE_RULE };
      return { ok: true, target };
    }
    // An LLM gateway runner has no address or key of its own: the run is a loop of model calls made through the platform's gateway on the runner's alias (`model-runtime.ts`).
    if (runner.kind === 'llm_gateway') {
      if (runner.model_alias === null) return refuse('not_set_up', `This bot runs on ${runner.label}, which is not set up yet. An admin has to pick its model alias.`);
      const target: RunnerTarget = { ...base, kind: 'llm_gateway', address: null, key: null, agent: 'hermes', guard: false, modelAlias: runner.model_alias };
      return { ok: true, target };
    }
    // The pod is the team's own: its address is where the platform registered it (the reserved connection `managed`), and each bot's profile has its own key,
    // which only runtime-hermes holds. So the address comes back, the key does not.
    const pod = (await tx.query<{ base_url: string | null }>("SELECT base_url FROM app.hermes_connections WHERE team_id = $1::uuid AND name = 'managed'", [query.teamId])).rows[0];
    if (!pod || pod.base_url === null) return refuse('not_set_up', `This bot runs on ${runner.label}, but the team's Hermes pod is not running yet.`);
    const target: RunnerTarget = { ...base, kind: 'hermes_pod', address: pod.base_url, key: null, agent: 'hermes', guard: false };
    return { ok: true, target };
  });
}

/**
 * The loader's question (P19-03): may a bot of this team name this runner in `placement.runs_on`? Answers on the caller's transaction. Existence and the team list only: a switched-off or
 * not-ready runner is no reason to refuse the definition (an admin may switch it back on), it is a reason to refuse a run. The sentence never says whether a runner the team may not use exists.
 */
export async function checkPlacement(tx: PluginTx, query: { teamId: string; runner: string; runtimeGrants?: readonly string[]; nativeGrants?: readonly string[] }): Promise<RunnerPlacementCheck> {
  const team = (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.teams WHERE id = $1::uuid', [query.teamId])).rows[0];
  if (!team) return { ok: false, message: 'The team of this bot could not be found.' };
  const runner = (await tx.query<{ id: string; all_teams: boolean; kind: string; label: string }>('SELECT id, all_teams, kind, label FROM app.bot_runners WHERE workspace_id = $1::uuid AND name = $2', [team.workspace_id, query.runner])).rows[0];
  if (!runner || !(await openToTeam(tx, runner, query.teamId))) {
    return { ok: false, message: `There is no runner called "${query.runner}" that this team may use. Pick one from the Runs on list on the bot's page, or ask an admin to add the team to it.` };
  }
  // A model-only runner has no shell, no files and no browser (P19-10), and the platform posts the reply for the bot (so the bot needs a way to post): a bot that asks for a shell,
  // files or a browser, or (when its native capabilities are given) has no way to post, cannot be placed on it, and is told which.
  if (runner.kind === 'llm_gateway') {
    const problem = modelRunnerProblem(runner.label, { runtime: query.runtimeGrants ?? [], native: query.nativeGrants });
    if (problem !== null) return { ok: false, message: problem };
  }
  return { ok: true };
}

/** What kind of runner `runner` is for a team's workspace, and its model alias; null when there is none. On the caller's transaction. */
export async function kindOf(tx: PluginTx, query: { teamId: string; runner: string }): Promise<{ kind: RunnerTarget['kind']; modelAlias: string | null } | null> {
  const row = (
    await tx.query<{ kind: RunnerTarget['kind']; model_alias: string | null }>(
      `SELECT r.kind, r.model_alias FROM app.bot_runners r JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.id = $1::uuid WHERE r.name = $2`,
      [query.teamId, query.runner],
    )
  ).rows[0];
  return row ? { kind: row.kind, modelAlias: row.model_alias } : null;
}

/** The workspace default runner when this team may use it and it is enabled and of a kind that runs bots; and the team's usable pod runners. */
export async function teamRunners(ctx: PluginContext, query: { teamId: string }): Promise<TeamRunnerInfo> {
  return ctx.db.system(async (tx) => {
    const rows = await tx.query<{ name: string; kind: string; is_default: boolean; node: string | null }>(
      `SELECT r.name, r.kind, r.is_default, r.node
         FROM app.bot_runners r JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.id = $1::uuid
        WHERE r.enabled AND r.kind IN ('hermes_gateway', 'hermes_pod')
          AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = t.id))
        ORDER BY r.name`,
      [query.teamId],
    );
    const pods = rows.rows.filter((r) => r.kind === 'hermes_pod');
    // One pod per team, however many pod runners the team may use: the default runner's machine wins, then the first name (the rows are in name order).
    return {
      defaultRunner: rows.rows.find((r) => r.is_default)?.name ?? null,
      podRunners: pods.map((r) => r.name),
      podNode: pickPodNode(pods),
    };
  });
}

/** One team, one pod: the default pod runner decides the machine, then the first name (the rows are in name order). A pod runner with no machine chosen has no say. */
export function pickPodRunner<T extends { is_default: boolean; node: string | null }>(podRunners: readonly T[]): T | null {
  const pinned = podRunners.filter((r) => r.node !== null);
  return pinned.find((r) => r.is_default) ?? pinned[0] ?? null;
}

export function pickPodNode(podRunners: readonly { is_default: boolean; node: string | null }[]): string | null {
  return pickPodRunner(podRunners)?.node ?? null;
}

/**
 * The runner that decides the machine of each of `teamIds` (null: every team of the workspace), and the machine, by the rule of `pickPodRunner`. `override` stands in for
 * one runner's machine (the value it is about to get, or `'*'` for "any machine"), so the caller can ask which teams that runner governs. Only enabled pod runners the
 * team may use count.
 */
export async function podNodesByTeam(
  tx: PluginTx,
  workspaceId: string,
  teamIds: readonly string[] | null,
  override?: { runnerId: string; node: string | null },
): Promise<Map<string, { runnerId: string; node: string }>> {
  const rows = await tx.query<{ team_id: string; id: string; is_default: boolean; node: string | null }>(
    `SELECT t.id AS team_id, r.id, r.is_default, r.node
       FROM app.teams t JOIN app.bot_runners r ON r.workspace_id = t.workspace_id
      WHERE t.workspace_id = $1::uuid AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))
        AND r.enabled AND r.kind = 'hermes_pod'
        AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = t.id))
      ORDER BY r.name`,
    [workspaceId, teamIds === null ? null : [...teamIds]],
  );
  const byTeam = new Map<string, { id: string; is_default: boolean; node: string | null }[]>();
  for (const r of rows.rows) {
    const list = byTeam.get(r.team_id) ?? [];
    list.push({ id: r.id, is_default: r.is_default, node: override && r.id === override.runnerId ? override.node : r.node });
    byTeam.set(r.team_id, list);
  }
  const out = new Map<string, { runnerId: string; node: string }>();
  for (const [team, list] of byTeam) {
    const pick = pickPodRunner(list);
    if (pick !== null && pick.node !== null) out.set(team, { runnerId: pick.id, node: pick.node });
  }
  return out;
}

/**
 * The Claude Code (or Codex) runners with what their pod needs to be built: the machine, the concurrency, the teams on the list and the bots placed on them (P19-05). A runner open to every team
 * serves every team of its workspace. Runs as the system actor; no key or address is read.
 */
export async function podRunners(ctx: PluginContext, query: { kind: 'claude_cli' | 'codex_cli' }): Promise<PodRunnerInfo[]> {
  return ctx.db.system(async (tx) => {
    const runners = (
      await tx.query<{ id: string; workspace_id: string; name: string; enabled: boolean; all_teams: boolean; node: string | null; max_concurrent: number | null }>(
        'SELECT id, workspace_id, name, enabled, all_teams, node, max_concurrent FROM app.bot_runners WHERE kind = $1 ORDER BY workspace_id, name',
        [query.kind],
      )
    ).rows;
    const out: PodRunnerInfo[] = [];
    for (const r of runners) {
      const teams = (
        await tx.query<{ id: string; slug: string }>(
          r.all_teams
            ? 'SELECT id, slug FROM app.teams WHERE workspace_id = $1::uuid AND archived_at IS NULL ORDER BY slug'
            : 'SELECT t.id, t.slug FROM app.bot_runner_teams rt JOIN app.teams t ON t.id = rt.team_id WHERE rt.runner_id = $1::uuid AND t.archived_at IS NULL ORDER BY t.slug',
          [r.all_teams ? r.workspace_id : r.id],
        )
      ).rows;
      const bots =
        teams.length === 0
          ? []
          : (
              await tx.query<{ team_id: string; team_slug: string; bot_slug: string }>(
                `SELECT b.team_id, t.slug AS team_slug, b.slug AS bot_slug
                   FROM app.bots b JOIN app.teams t ON t.id = b.team_id
                  WHERE b.team_id = ANY($1::uuid[]) AND b.status = 'active' AND b.placement ->> 'runs_on' = $2
                  ORDER BY t.slug, b.slug`,
                [teams.map((t) => t.id), r.name],
              )
            ).rows.map((b) => ({ teamId: b.team_id, teamSlug: b.team_slug, botSlug: b.bot_slug }));
      out.push({ id: r.id, workspaceId: r.workspace_id, name: r.name, enabled: r.enabled, node: r.node, maxConcurrent: r.max_concurrent, teams, allTeams: r.all_teams, bots });
    }
    return out;
  });
}

/** States the controller may overwrite. `paused` and `needs_sign_in` are decided elsewhere (a limit, a refused sign-in) and only a new sign-in or the clock clears them. */
const POD_OWNED_STATES = ['not_set_up', 'waiting_for_sign_in', 'starting', 'ready', 'waiting_for_node', 'moving'];

export async function reportPodState(ctx: PluginContext, state: PodRunnerState): Promise<void> {
  await ctx.db.system(async (tx) => {
    await tx.query(
      `UPDATE app.bot_runners
          SET status = $2, status_detail = $3, last_checked_at = now(), updated_at = now()
        WHERE id = $1::uuid AND kind IN ('claude_cli', 'codex_cli')
          AND (status = ANY($4::text[]) OR (status = 'paused' AND paused_until IS NOT NULL AND paused_until <= now()))
          AND (status, status_detail) IS DISTINCT FROM ($2, $3)`,
      [state.runnerId, state.status, state.detail, POD_OWNED_STATES],
    );
  });
}

/** Count one run for a team and day. A runner that is not a Claude Code or Codex runner of the team's workspace is ignored. */
export async function recordUsage(ctx: PluginContext, input: { runner: string; teamId: string; seconds: number; cost: number | null }): Promise<void> {
  await ctx.db.system(async (tx) => {
    await tx.query(
      `INSERT INTO app.bot_runner_usage (workspace_id, runner_id, team_id, day, runs, seconds, cli_cost)
       SELECT r.workspace_id, r.id, t.id, (now() AT TIME ZONE 'UTC')::date, 1, $3::int, $4::numeric
         FROM app.bot_runners r JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.id = $2::uuid
        WHERE r.name = $1 AND r.kind IN ('claude_cli', 'codex_cli')
       ON CONFLICT (runner_id, team_id, day) DO UPDATE
         SET runs = app.bot_runner_usage.runs + 1, seconds = app.bot_runner_usage.seconds + EXCLUDED.seconds, cli_cost = app.bot_runner_usage.cli_cost + EXCLUDED.cli_cost`,
      [input.runner, input.teamId, Math.max(0, Math.round(input.seconds)), input.cost !== null && Number.isFinite(input.cost) && input.cost >= 0 ? input.cost : 0],
    );
  });
}

/** The words an admin reads on the page for each pause. */
const PAUSE_DETAIL = {
  claude_cli: {
    plan_limit: "The Claude plan's limit was reached. Runs wait until it resets.",
    needs_sign_in: 'Claude refused this sign-in. Upload a new sign-in file to start this runner again.',
  },
  codex_cli: {
    plan_limit: "The ChatGPT plan's limit was reached. Runs wait until it resets.",
    needs_sign_in: 'Codex refused this sign-in. Upload a new sign-in file to start this runner again.',
  },
} as const;

/** A pause with no usable reset time lasts this long, then the next run tries again (a pause with no end would hold the runner until an admin uploads a file). */
export const DEFAULT_PAUSE_MS = 30 * 60_000;
/** The longest pause taken from the CLI's own text (its weekly limit is the longest); a number in the text that looks like a far-off date is not trusted. */
export const MAX_PAUSE_MS = 8 * 24 * 3_600_000;

/** When a plan-limit pause ends: the reset time the bridge read, kept within a day-and-a-bit of sanity; else a short default. */
export function pauseEnd(resetsAt: string | null, nowMs: number): string {
  const asked = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  const ms = Number.isFinite(asked) && asked > nowMs ? Math.min(asked, nowMs + MAX_PAUSE_MS) : nowMs + DEFAULT_PAUSE_MS;
  return new Date(ms).toISOString();
}

export async function pauseRunner(ctx: PluginContext, input: { runner: string; teamId: string; reason: 'plan_limit' | 'needs_sign_in'; until: string | null }): Promise<void> {
  await ctx.db.system(async (tx) => {
    const status = input.reason === 'plan_limit' ? 'paused' : 'needs_sign_in';
    const until = input.reason === 'plan_limit' ? pauseEnd(input.until, ctx.runtime.now().getTime()) : null;
    // The detail sentence names the program, so it is chosen by the runner's kind: the kind is read here, then written with the state in one statement.
    const kind = (
      await tx.query<{ kind: string }>('SELECT r.kind FROM app.bot_runners r JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.id = $2::uuid WHERE r.name = $1', [input.runner, input.teamId])
    ).rows[0]?.kind;
    if (kind !== 'claude_cli' && kind !== 'codex_cli') return;
    const changed = await tx.query<{ id: string; workspace_id: string; name: string }>(
      `UPDATE app.bot_runners r
          SET status = $3, status_detail = $4, paused_until = $5::timestamptz, last_checked_at = now(), updated_at = now()
         FROM app.teams t
        WHERE r.name = $1 AND r.kind = $6 AND t.id = $2::uuid AND t.workspace_id = r.workspace_id
          AND (r.status, r.paused_until) IS DISTINCT FROM ($3, $5::timestamptz)
        RETURNING r.id, r.workspace_id, r.name`,
      [input.runner, input.teamId, status, PAUSE_DETAIL[kind][input.reason], until, kind],
    );
    const row = changed.rows[0];
    if (!row) return;
    const at = ctx.runtime.now().toISOString();
    if (kind === 'codex_cli') await ctx.audit.emit(tx, { type: 'codex_pod.runner.paused', workspaceId: row.workspace_id, runnerId: row.id, name: row.name, reason: input.reason, until, at });
    else await ctx.audit.emit(tx, { type: 'claude_pod.runner.paused', workspaceId: row.workspace_id, runnerId: row.id, name: row.name, reason: input.reason, until, at });
  });
}

export function createBotRunnersProvider(ctx: PluginContext): BotRunnersProvider {
  return {
    id: 'bot.runners',
    resolveRunner: (query) => resolveRunner(ctx, query),
    checkPlacement: (tx, query) => checkPlacement(tx, query),
    kindOf: (tx, query) => kindOf(tx, query),
    teamRunners: (query) => teamRunners(ctx, query),
    podRunners: (query) => podRunners(ctx, query),
    reportPodState: (state) => reportPodState(ctx, state),
    recordUsage: (input) => recordUsage(ctx, input),
    pauseRunner: (input) => pauseRunner(ctx, input),
  };
}
