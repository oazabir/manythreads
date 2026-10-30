import { definePlugin, type EgressVerdict } from '@manythreads/sdk';
import { isProviderHost } from '@manythreads/shared';
import { judgeTargets, judgeTeamHosts, presetOf } from './egress.ts';
import { registerRoutes } from './routes.ts';

export { judgeTargets, judgeTeamHosts, presetOf } from './egress.ts';
export type { EgressRefusal } from './egress.ts';

/**
 * guardrails-egress (SPEC §15, PLAN P5-21): the destination half of the `pre_egress` chain. It decides whether a call may reach where it is
 * going, before anything reads the text: under `air-gapped` only the `local` alias, under `strict-egress` only hosts the workspace
 * allowlisted (a provider on localhost is not egress), under the other two presets everything. The caller resolves the targets (for the LLM
 * gateway: the alias and every link of its fallback chain with the host each reaches) and this plugin judges them. Each team can also have its own
 * list of reachable hosts and a proxy address (Settings > Workspace > Data protection); the list applies to everything a team's bots send except
 * a model call, and a model provider's domain can not be on it.
 *
 * It loads before guardrails-dlp, so a refused destination is refused before the content check reads the prompt. The refusal is written as
 * `guardrails.egress.decided` unless the caller records its own decision (`input.recorded`).
 */
export default definePlugin({
  manifest: {
    name: 'guardrails-egress',
    version: '0.1.0',
    kind: 'server',
    extends: ['hook.pre_egress', 'event.emit'],
    events: { emits: ['guardrails.egress.decided', 'guardrails.policy.updated'], consumes: [] },
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    ctx.hooks.preEgress(async (input, tx): Promise<EgressVerdict | void> => {
      if (!input.targets || input.targets.length === 0) return;
      const preset = presetOf(input.preset);
      let refusal = judgeTargets(preset, input.allowlist ?? [], input.targets);
      // The team's own list applies to what a team's bots send anywhere but to a model: a model call is judged by the workspace's model setup and
      // preset alone, so a team list can neither open a way to a hosted model nor close the way to the workspace's own.
      if (!refusal && input.destination !== 'llm' && input.teamId) {
        const row = (await tx.query<{ enforce: boolean; hosts: string[] }>('SELECT enforce, hosts FROM app.team_egress WHERE team_id = $1::uuid', [input.teamId])).rows[0];
        if (row) refusal = judgeTeamHosts(row.enforce, row.hosts, input.allowlist ?? [], input.targets, (host) => isProviderHost(host));
      }
      if (!refusal) return;
      if (input.recorded !== true) {
        await ctx.audit.emit(tx, {
          type: 'guardrails.egress.decided',
          workspaceId: input.workspaceId,
          destination: input.destination,
          botId: input.botId ?? null,
          teamId: input.teamId ?? null,
          preset,
          outcome: 'block',
          target: refusal.target,
          host: refusal.host,
          at: ctx.runtime.now().toISOString(),
        });
      }
      return { outcome: 'block', reason: 'preset', message: refusal.message };
    });
  },
});
