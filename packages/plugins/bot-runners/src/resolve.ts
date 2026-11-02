import type { BotRunnersProvider, PluginContext, RunnerResolution, RunnerTarget } from '@manythreads/sdk';
import { BotRunnerName } from '@manythreads/shared';
import { effectiveStatus, RUNNER_SELECT, type RunnerRow } from './rows.ts';

// `resolveRunner`: the one place that turns a runner's NAME into where a run goes (PLAN P19-02). A connection, a team pod and a runner all answer "where does
// this bot's run go?"; runtime-hermes asks here for every runner and for every connection an admin has adopted, so two lookups cannot disagree.
//
// It runs as the system actor, because it is the only reader of a Hermes gateway's key. What it returns never leaves the server: a BOT.md, a bot API answer
// and a log carry the name only. The refusals are plain sentences safe to post in a thread; none of them holds an address, a key or a node.

export const DEFAULT_PROFILE_RULE = '{bot}';

const refuse = (reason: Extract<RunnerResolution, { ok: false }>['reason'], message: string): RunnerResolution => ({ ok: false, reason, message });

/** The name as a sentence may carry it: only what the name rule allows, so a hostile BOT.md cannot put text into a message by way of it. */
const shown = (name: string): string => (BotRunnerName.safeParse(name).success ? `"${name}"` : 'that name');

export async function resolveRunner(ctx: PluginContext, query: { teamId: string; runner: string }): Promise<RunnerResolution> {
  return ctx.db.system(async (tx) => {
    const team = (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.teams WHERE id = $1::uuid', [query.teamId])).rows[0];
    if (!team) return refuse('unknown', `This bot's team could not be found, so its runner ${shown(query.runner)} cannot be used.`);
    const runner = (
      await tx.query<RunnerRow>(`SELECT ${RUNNER_SELECT} WHERE r.workspace_id = $1::uuid AND r.name = $2`, [team.workspace_id, query.runner])
    ).rows[0];
    if (!runner) return refuse('unknown', `There is no runner called ${shown(query.runner)}. An admin may have removed it.`);
    // The team's list is judged first, and in words that do not name the runner: a team that is not on the list learns nothing about it, not even that it exists or is off.
    if (!runner.all_teams) {
      const listed = (await tx.query('SELECT 1 FROM app.bot_runner_teams WHERE runner_id = $1::uuid AND team_id = $2::uuid', [runner.id, query.teamId])).rows.length > 0;
      if (!listed) return refuse('not_available_to_team', 'This team may not use that runner. An admin can add the team to its list.');
    }
    if (!runner.enabled) return refuse('disabled', `The runner "${runner.label}" has been switched off by an admin.`);
    const status = effectiveStatus(runner);
    const base = { runner: runner.name, status, profileRule: runner.profile_rule ?? DEFAULT_PROFILE_RULE } as const;

    if (runner.kind === 'hermes_gateway') {
      if (runner.base_url === null || runner.secret_id === null) return refuse('not_set_up', `The runner "${runner.label}" is not set up yet. An admin has to give it an address and a key.`);
      const key = await ctx.secrets.get(tx, runner.secret_id);
      const target: RunnerTarget = { ...base, kind: 'hermes_gateway', address: runner.base_url, key, agent: 'hermes', guard: true };
      return { ok: true, target };
    }
    if (runner.kind === 'hermes_pod') {
      // The pod is the team's own: its address is where the platform registered it (the reserved connection `managed`), and each bot's profile has its own key,
      // which only runtime-hermes holds. So the address comes back, the key does not.
      const pod = (await tx.query<{ base_url: string | null }>("SELECT base_url FROM app.hermes_connections WHERE team_id = $1::uuid AND name = 'managed'", [query.teamId])).rows[0];
      if (!pod || pod.base_url === null) return refuse('not_set_up', `The team's Hermes pod behind "${runner.label}" is not running yet.`);
      const target: RunnerTarget = { ...base, kind: 'hermes_pod', address: pod.base_url, key: null, agent: 'hermes', guard: false };
      return { ok: true, target };
    }
    return refuse('not_runnable', `The runner "${runner.label}" cannot run bots yet.`);
  });
}

export function createBotRunnersProvider(ctx: PluginContext): BotRunnersProvider {
  return { id: 'bot.runners', resolveRunner: (query) => resolveRunner(ctx, query) };
}
