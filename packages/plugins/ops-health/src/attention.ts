import { json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { GetAttentionResponse, getAttentionRoute, type AttentionProblem } from '@manythreads/shared';

// The bar at the top of the screen (owner request 2026-11-24): what stopped the bots and only an admin can fix. Read from the runners' own state (a run or a check that met a
// refused sign-in marks a runner `needs_sign_in`; a runner that lost its sign-in waits for one: counted after five minutes, because a pod that restarts waits a moment
// for its own sign-in check) and from the newest test of each model alias (the regular key
// check in gateway-llm, or an admin's test): a key the provider refused (`auth`) and that nobody has changed since. Owners and admins only; anyone else gets an empty list, so
// the shell can ask for every person without learning their role first.

type RunnerRow = { id: string; label: string; kind: string; agent: string | null; status: string };
type KeyRow = { provider_id: string | null; provider: string | null; aliases: string[] };
type TeamRow = { id: string; label: string; kind: string; agent: string | null; team_id: string; team_slug: string; team_name: string; state: string };

const AGENT_WORDS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes', 'hermes-acp': 'Hermes' };

/** The tool a runner signs in to, in the words a person knows. */
export function agentWords(r: Pick<RunnerRow, 'kind' | 'agent'>): string {
  if (r.kind === 'claude_cli') return 'Claude Code';
  if (r.kind === 'codex_cli') return 'Codex';
  if (r.kind === 'hermes_pod') return 'Hermes';
  return AGENT_WORDS[r.agent ?? ''] ?? 'its agent';
}

export function runnerProblem(r: RunnerRow): AttentionProblem {
  const tool = agentWords(r);
  const text =
    r.status === 'needs_sign_in'
      ? `The ${tool} sign-in of runner “${r.label}” has expired or was refused. Bots on it cannot work until someone signs in again.`
      : `Runner “${r.label}” is not signed in to ${tool}. Bots on it cannot work until someone signs in.`;
  return { kind: 'runner_sign_in', key: `runner:${r.id}`, text: text.slice(0, 300), link: `/settings/workspace/runners?signin=${r.id}`, action: 'Sign in' };
}

/** A team of a runner where each team signs in (P35-10) whose own sign-in is gone: its bots cannot work, the runner's other teams may. */
export function teamProblem(r: TeamRow): AttentionProblem {
  const text =
    r.state === 'refused'
      ? `The ${agentWords(r)} sign-in of team “${r.team_name}” on runner “${r.label}” has expired or was refused. Its bots on that runner cannot work until someone signs the team in again.`
      : `Team “${r.team_name}” is not signed in to ${agentWords(r)} on runner “${r.label}”. Its bots on that runner cannot work until someone signs the team in.`;
  return {
    kind: 'runner_sign_in',
    key: `runner:${r.id}:team:${r.team_id}`,
    text: text.slice(0, 300),
    link: `/settings/workspace/runners?signin=${r.id}&team=${encodeURIComponent(r.team_slug)}`.slice(0, 200),
    action: 'Sign in',
  };
}

export function keyProblem(k: KeyRow): AttentionProblem {
  const aliases = k.aliases.slice(0, 5).join(', ');
  const who = k.provider === null ? 'A model provider' : `The ${k.provider} provider`;
  return {
    kind: 'model_key',
    key: `model:${k.provider_id ?? aliases}`,
    text: `${who} refused its API key (models: ${aliases}). The key may have expired or been revoked; bots that use these models cannot work.`.slice(0, 300),
    link: '/settings/workspace/llm',
    action: 'Update the key',
  };
}

export async function attentionFor(tx: PluginTx): Promise<AttentionProblem[]> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') return [];
  const runners = await tx.query<RunnerRow>(
    `SELECT id::text, label, kind, agent, status FROM app.bot_runners
      WHERE enabled AND kind <> 'llm_gateway'
        AND (status = 'needs_sign_in' OR (status = 'waiting_for_sign_in' AND updated_at < now() - interval '5 minutes' AND sign_in_scope = 'shared'))
      ORDER BY (status = 'needs_sign_in') DESC, label LIMIT 20`,
  );
  // A runner where each team signs in is named per team: a team whose pod said "signed out" (the controller stores only what a pod answered, so a pod that restarts is not named),
  // and that has a bot placed on the runner (a team without one is not stopped by it).
  const teams = await tx.query<TeamRow>(
    `SELECT r.id::text, r.label, r.kind, r.agent, t.id::text AS team_id, t.slug AS team_slug, t.name AS team_name, s.state
       FROM app.bot_runner_team_signins s
       JOIN app.bot_runners r ON r.id = s.runner_id
       JOIN app.teams t ON t.id = s.team_id
      WHERE r.enabled AND r.sign_in_scope = 'per_team' AND s.state IN ('signed_out', 'refused') AND t.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM app.bots b WHERE b.team_id = t.id AND b.status = 'active' AND b.placement ->> 'runs_on' = r.name)
      ORDER BY (s.state = 'refused') DESC, r.label, t.name LIMIT 20`,
  );
  // the newest test of each alias, failed because the provider refused the key, and still about the alias and provider as they are now
  const keys = await tx.query<KeyRow>(
    `SELECT p.id::text AS provider_id, p.name AS provider, array_agg(t.alias ORDER BY t.alias) AS aliases
       FROM app.llm_alias_tests t
       JOIN app.llm_aliases a ON a.workspace_id = t.workspace_id AND a.alias = t.alias
       LEFT JOIN app.llm_providers p ON p.id = a.provider_id
      WHERE t.outcome = 'failed' AND t.cause = 'auth' AND t.tested_at >= a.updated_at AND (p.id IS NULL OR t.tested_at >= p.updated_at)
      GROUP BY p.id, p.name
      ORDER BY p.name LIMIT 20`,
  );
  return [...runners.rows.map(runnerProblem), ...teams.rows.map(teamProblem), ...keys.rows.map(keyProblem)].slice(0, 50);
}

export function registerAttentionRoute(ctx: PluginContext): void {
  ctx.http.route({
    method: getAttentionRoute.method,
    path: getAttentionRoute.path,
    schema: { response: GetAttentionResponse },
    handler: route(async (_req, tx) => json({ problems: await attentionFor(tx) })),
  });
}
