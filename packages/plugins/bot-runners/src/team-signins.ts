import type { PluginTx } from '@manythreads/sdk';
import { compareSlugs, type AgentAuthTeamState, type BotRunnerTeamSignInState } from '@manythreads/shared';

// The sign-in of each team of a runner where each team signs in (P35-10, docs/plans/per-team-sign-in.md section 7): stored in `app.bot_runner_team_signins`, written by the system role
// (the pod controller's pass, the Runners page's reads, a run that met a refused sign-in or a plan limit), read by the page and the run resolver, so no request waits on a live probe.
//
// A team is SERVED when it has a pod on the runner: the controller makes one per team with an active bot placed on the runner, or, while no bot is, one for the first team of the
// list. "First" is `compareSlugs` order (plain code units) here and in claude-pods' `podsOf`, so the two cannot pick different teams.

export interface TeamSignIn {
  teamId: string;
  slug: string;
  name: string;
  served: boolean;
  state: BotRunnerTeamSignInState | null;
  pausedUntil: Date | null;
  checkedAt: Date | null;
}

type Row = { runner_id: string; team_id: string; slug: string; name: string; has_bot: boolean; state: BotRunnerTeamSignInState | null; paused_until: Date | null; checked_at: Date | null };

/** The rule of "served", from every team open to one runner. Exported for the test that pins it against the controller's. */
export function markServed<T extends { slug: string; hasBot: boolean }>(teams: readonly T[]): (T & { served: boolean })[] {
  const sorted = [...teams].sort((a, b) => compareSlugs(a.slug, b.slug));
  const anyBot = sorted.some((t) => t.hasBot);
  return sorted.map((t, i) => ({ ...t, served: anyBot ? t.hasBot : i === 0 }));
}

/** Every team open to each of the runners (its list, or every live team of the workspace), in slug order, with whether it is served and its stored state. One statement. System role. */
export async function teamSignInsFor(sys: PluginTx, runnerIds: readonly string[]): Promise<Map<string, TeamSignIn[]>> {
  const out = new Map<string, TeamSignIn[]>();
  if (runnerIds.length === 0) return out;
  const rows = (
    await sys.query<Row>(
      `SELECT r.id AS runner_id, t.id AS team_id, t.slug, t.name,
              EXISTS (SELECT 1 FROM app.bots b WHERE b.team_id = t.id AND b.status = 'active' AND b.placement ->> 'runs_on' = r.name) AS has_bot,
              s.state, s.paused_until, s.checked_at
         FROM app.bot_runners r
         JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.archived_at IS NULL
          AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = t.id))
         LEFT JOIN app.bot_runner_team_signins s ON s.runner_id = r.id AND s.team_id = t.id
        WHERE r.id = ANY($1::uuid[])`,
      [[...runnerIds]],
    )
  ).rows;
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.runner_id, [...(by.get(r.runner_id) ?? []), r]);
  for (const id of runnerIds) {
    const teams = markServed((by.get(id) ?? []).map((r) => ({ ...r, hasBot: r.has_bot })));
    out.set(id, teams.map((t) => ({ teamId: t.team_id, slug: t.slug, name: t.name, served: t.served, state: t.state, pausedUntil: t.paused_until, checkedAt: t.checked_at })));
  }
  return out;
}

export async function teamSignIns(sys: PluginTx, runner: { id: string }): Promise<TeamSignIn[]> {
  return (await teamSignInsFor(sys, [runner.id])).get(runner.id) ?? [];
}

/** One team of a runner by slug, if it is open to the runner, with whether it is served. One statement (the served rule in SQL: byte order, as `compareSlugs`). System role. */
export async function oneTeam(sys: PluginTx, runnerId: string, slug: string): Promise<{ teamId: string; slug: string; name: string; served: boolean } | null> {
  const row = (
    await sys.query<{ id: string; slug: string; name: string; served: boolean }>(
      `WITH open AS (
         SELECT t.id, t.slug, t.name, EXISTS (SELECT 1 FROM app.bots b WHERE b.team_id = t.id AND b.status = 'active' AND b.placement ->> 'runs_on' = r.name) AS has_bot
           FROM app.bot_runners r
           JOIN app.teams t ON t.workspace_id = r.workspace_id AND t.archived_at IS NULL
            AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = t.id))
          WHERE r.id = $1::uuid
       )
       SELECT o.id, o.slug, o.name,
              (o.has_bot OR (NOT EXISTS (SELECT 1 FROM open WHERE has_bot) AND o.slug COLLATE "C" = (SELECT min(slug COLLATE "C") FROM open))) AS served
         FROM open o WHERE o.slug = $2`,
      [runnerId, slug],
    )
  ).rows[0];
  return row ? { teamId: row.id, slug: row.slug, name: row.name, served: row.served } : null;
}

/** The page's shape of one team. */
export const toTeamState = (t: TeamSignIn): AgentAuthTeamState =>
  ({
    teamId: t.teamId,
    slug: t.slug,
    name: t.name,
    served: t.served,
    state: t.state,
    pausedUntil: t.pausedUntil === null ? null : t.pausedUntil.toISOString(),
    checkedAt: t.checkedAt === null ? null : t.checkedAt.toISOString(),
  }) as AgentAuthTeamState;

/** A team whose own sign-in works: signed in, or at its plan limit (still signed in; its runs wait for the reset). */
export const isSignedIn = (state: BotRunnerTeamSignInState | null): boolean => state === 'signed_in' || state === 'limited';

/** How many served teams are signed in, of how many are served (the runner row's "2 of 3 teams signed in"). `onServer`: every team open to the runner counts (any may sign in). */
export function countSignedIn(teams: readonly TeamSignIn[], onServer = false): { signedIn: number; served: number } {
  const served = onServer ? [...teams] : teams.filter((t) => t.served);
  return { signedIn: served.filter((t) => isSignedIn(t.state)).length, served: served.length };
}

/**
 * Store a team's sign-in state. Only for a runner that still signs in per team: the runner row is locked FOR SHARE first, so a scope switch that holds it waits this out (or
 * this waits for the switch, and then sees `shared` and writes nothing). A plain write (`force` absent: the controller's pass, the page's status reads) never overwrites
 * `refused` or a `limited` that has not run out: the pod's own status may still read an old file as signed in. `force` is a real sign-in or sign-out on the page, or a run's
 * own finding. System role.
 */
export async function storeTeamSignIn(
  sys: PluginTx,
  runnerId: string,
  teamId: string,
  state: BotRunnerTeamSignInState,
  opts: { force?: boolean; pausedUntil?: string | null } = {},
): Promise<void> {
  const runner = (await sys.query<{ id: string }>(`SELECT id FROM app.bot_runners WHERE id = $1::uuid AND sign_in_scope = 'per_team' FOR SHARE`, [runnerId])).rows[0];
  if (!runner) return;
  await sys.query(
    `INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state, paused_until, checked_at)
     SELECT r.id, t.id, $3, $4::timestamptz, now() FROM app.bot_runners r JOIN app.teams t ON t.id = $2::uuid AND t.workspace_id = r.workspace_id
      WHERE r.id = $1::uuid
     ON CONFLICT (runner_id, team_id) DO UPDATE SET state = EXCLUDED.state, paused_until = EXCLUDED.paused_until, checked_at = EXCLUDED.checked_at
      WHERE $5::boolean
         OR NOT (app.bot_runner_team_signins.state = 'refused'
                 OR (app.bot_runner_team_signins.state = 'limited' AND app.bot_runner_team_signins.paused_until > now()))`,
    [runnerId, teamId, state, state === 'limited' ? (opts.pausedUntil ?? null) : null, opts.force === true],
  );
}

/** Whether any team of the runner has a working sign-in, from the stored states (a team whose pod did not answer this pass keeps the state it had). System role. */
export async function anyTeamSignedIn(sys: PluginTx, runnerId: string): Promise<boolean> {
  return (await sys.query(`SELECT 1 FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid AND state IN ('signed_in', 'limited') LIMIT 1`, [runnerId])).rows.length > 0;
}

/**
 * The runner of a per-team sign-in is ready while at least one of its teams is signed in, and waits for a sign-in when none is. Only the two states that change touches (a paused
 * runner or one that is off keeps its state). Run as the system role, after `storeTeamSignIn`.
 */
export async function followTeams(sys: PluginTx, runnerId: string): Promise<void> {
  const signed = await anyTeamSignedIn(sys, runnerId);
  await sys.query(
    `UPDATE app.bot_runners r
        SET status = CASE WHEN $2::boolean THEN 'ready' ELSE 'waiting_for_sign_in' END,
            status_detail = CASE WHEN $2::boolean THEN NULL ELSE 'No team has signed in yet. Choose Sign-in on this runner to sign a team in.' END,
            last_checked_at = now(), updated_at = now()
      -- the runners that may sign in per team: the same rule as CHECK bot_runners_sign_in_scope_kind (bot-runners 0011) and hasSignInScopeChoice (@manythreads/shared)
      WHERE r.id = $1::uuid AND r.sign_in_scope = 'per_team' AND (r.kind IN ('claude_cli', 'codex_cli') OR (r.kind = 'server_agent' AND r.agent IN ('claude-code', 'codex')))
        AND (($2::boolean AND r.status = 'waiting_for_sign_in') OR (NOT $2::boolean AND r.status = 'ready'))`,
    [runnerId, signed],
  );
}

/** A team that left the runner's list (or was archived) has no sign-in to keep here. Run as the system role. */
export async function pruneTeamSignIns(sys: PluginTx, runnerId: string): Promise<void> {
  await sys.query(
    `DELETE FROM app.bot_runner_team_signins s
      USING app.bot_runners r
      WHERE s.runner_id = $1::uuid AND r.id = s.runner_id
        AND NOT EXISTS (
          SELECT 1 FROM app.teams t
           WHERE t.id = s.team_id AND t.archived_at IS NULL
             AND (r.all_teams OR EXISTS (SELECT 1 FROM app.bot_runner_teams rt WHERE rt.runner_id = r.id AND rt.team_id = t.id))
        )`,
    [runnerId],
  );
}
