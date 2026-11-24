import { json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { GetAttentionResponse, getAttentionRoute, type AttentionProblem } from '@manythreads/shared';

// The bar at the top of the screen (owner request 2026-11-24): what stopped the bots and only an admin can fix. Read from the runners' own state (a run or a check that met a
// refused sign-in marks a runner `needs_sign_in`; a server or bridge runner that lost its sign-in waits for one) and from the newest test of each model alias (the regular key
// check in gateway-llm, or an admin's test): a key the provider refused (`auth`) and that nobody has changed since. Owners and admins only; anyone else gets an empty list, so
// the shell can ask for every person without learning their role first.

type RunnerRow = { id: string; label: string; kind: string; agent: string | null; status: string };
type KeyRow = { provider_id: string | null; provider: string | null; aliases: string[] };

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
      WHERE enabled AND status IN ('needs_sign_in', 'waiting_for_sign_in') AND kind <> 'llm_gateway'
      ORDER BY (status = 'needs_sign_in') DESC, label LIMIT 20`,
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
  return [...runners.rows.map(runnerProblem), ...keys.rows.map(keyProblem)];
}

export function registerAttentionRoute(ctx: PluginContext): void {
  ctx.http.route({
    method: getAttentionRoute.method,
    path: getAttentionRoute.path,
    schema: { response: GetAttentionResponse },
    handler: route(async (_req, tx) => json({ problems: await attentionFor(tx) })),
  });
}
