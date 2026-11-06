import { BotRunner, type BotRunnerKind, type BotRunnerStatus, type BotRunnerTeam } from '@manythreads/shared';
import type { PluginTx } from '@manythreads/sdk';

// The one mapper of `app.bot_runners`: a row to the shared type. Nothing else converts rows. The key is never read here, only whether there is one.

/** A row as the SQL columns come back; PostgreSQL returns timestamptz as Date. `owner_name` comes from the join in `RUNNER_SELECT`. */
export interface RunnerRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  name: string;
  label: string;
  kind: BotRunnerKind;
  enabled: boolean;
  is_default: boolean;
  all_teams: boolean;
  base_url: string | null;
  secret_id: string | null;
  profile_rule: string | null;
  node: string | null;
  model_alias: string | null;
  owner_actor_id: string | null;
  owner_name: string | null;
  plan_label: string | null;
  credentials_expires_at: Date | null;
  uploaded_at: Date | null;
  terms_accepted_by: string | null;
  terms_accepted_at: Date | null;
  max_concurrent: number | null;
  status: BotRunnerStatus;
  paused_until: Date | null;
  status_detail: string | null;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The columns, with the owner's display name. Use as `SELECT ${RUNNER_SELECT} WHERE ...`. */
export const RUNNER_SELECT = `r.id, r.workspace_id, r.name, r.label, r.kind, r.enabled, r.is_default, r.all_teams, r.base_url, r.secret_id, r.profile_rule,
  r.node, r.model_alias, r.owner_actor_id, pe.display_name AS owner_name, r.plan_label, r.credentials_expires_at, r.uploaded_at, r.terms_accepted_by,
  r.terms_accepted_at, r.max_concurrent, r.status, r.paused_until, r.status_detail, r.last_checked_at, r.created_at, r.updated_at
  FROM app.bot_runners r
  LEFT JOIN app.actors ac ON ac.id = r.owner_actor_id AND ac.kind = 'person'
  LEFT JOIN app.people pe ON pe.id = ac.ref_id`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** A disabled runner always reads `off`, whatever was last found. */
export const effectiveStatus = (r: Pick<RunnerRow, 'enabled' | 'status'> & { paused_until?: Date | null }, now: number = Date.now()): BotRunnerStatus => {
  if (!r.enabled) return 'off';
  // a plan limit pause ends by itself when its time has passed
  if (r.status === 'paused' && r.paused_until != null && r.paused_until.getTime() <= now) return 'ready';
  return r.status;
};

export function toBotRunner(r: RunnerRow, teams: readonly BotRunnerTeam[], botCount: number): BotRunner {
  return BotRunner.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    label: r.label,
    kind: r.kind,
    enabled: r.enabled,
    isDefault: r.is_default,
    allTeams: r.all_teams,
    teams: r.all_teams ? [] : teams,
    baseUrl: r.base_url,
    hasKey: r.secret_id !== null,
    profileRule: r.profile_rule,
    node: r.node,
    modelAlias: r.model_alias,
    ownerActorId: r.owner_actor_id,
    ownerName: r.owner_name,
    planLabel: r.plan_label,
    credentialsExpiresAt: iso(r.credentials_expires_at),
    uploadedAt: iso(r.uploaded_at),
    termsAcceptedBy: r.terms_accepted_by,
    termsAcceptedAt: iso(r.terms_accepted_at),
    maxConcurrent: r.max_concurrent,
    status: effectiveStatus(r),
    statusDetail: r.status_detail,
    pausedUntil: iso(r.paused_until),
    lastCheckedAt: iso(r.last_checked_at),
    botCount,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
}

/** The teams on the lists of the given runners, by runner id. */
export async function teamsOf(tx: PluginTx, runnerIds: readonly string[]): Promise<Map<string, BotRunnerTeam[]>> {
  const out = new Map<string, BotRunnerTeam[]>();
  if (runnerIds.length === 0) return out;
  const res = await tx.query<{ runner_id: string; team_id: string; slug: string; name: string }>(
    `SELECT rt.runner_id, t.id AS team_id, t.slug, t.name
       FROM app.bot_runner_teams rt JOIN app.teams t ON t.id = rt.team_id
      WHERE rt.runner_id = ANY($1::uuid[])
      ORDER BY t.name, t.id`,
    [runnerIds],
  );
  for (const row of res.rows) {
    const list = out.get(row.runner_id) ?? [];
    list.push({ teamId: row.team_id, slug: row.slug, name: row.name } as BotRunnerTeam);
    out.set(row.runner_id, list);
  }
  return out;
}

/** The bots placed on the given runners (by `runs_on`, or through a connection that was adopted into the runner), with the teams they belong to. */
export async function placementsOf(tx: PluginTx, workspaceId: string, runnerIds: readonly string[]): Promise<Map<string, { count: number; teams: string[] }>> {
  const out = new Map<string, { count: number; teams: string[] }>();
  if (runnerIds.length === 0) return out;
  const res = await tx.query<{ runner_id: string; bot_id: string; team_name: string }>(
    `SELECT DISTINCT r.id AS runner_id, b.id AS bot_id, t.name AS team_name
       FROM app.bot_runners r
       JOIN app.bots b ON b.workspace_id = r.workspace_id
       JOIN app.teams t ON t.id = b.team_id
      WHERE r.workspace_id = $1::uuid AND r.id = ANY($2::uuid[]) AND b.status IN ('active', 'disabled')
        AND (
          b.placement ->> 'runs_on' = r.name
          OR EXISTS (
            SELECT 1 FROM app.hermes_connections c
             WHERE c.team_id = b.team_id AND c.workspace_id = r.workspace_id AND c.runner_name = r.name
               AND c.name = b.placement -> 'gateway' ->> 'connection'
          )
        )`,
    [workspaceId, runnerIds],
  );
  for (const row of res.rows) {
    const entry = out.get(row.runner_id) ?? { count: 0, teams: [] };
    entry.count += 1;
    if (!entry.teams.includes(row.team_name)) entry.teams.push(row.team_name);
    out.set(row.runner_id, entry);
  }
  for (const entry of out.values()) entry.teams.sort();
  return out;
}
