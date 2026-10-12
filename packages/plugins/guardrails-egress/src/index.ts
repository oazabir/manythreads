import { definePlugin, type EgressVerdict } from '@manythreads/sdk';
import { judgeTargets, presetOf } from './egress.ts';

export { judgeTargets, presetOf } from './egress.ts';
export type { EgressRefusal } from './egress.ts';

/**
 * guardrails-egress (SPEC §15, PLAN P5-21): the destination half of the `pre_egress` chain. It decides whether a call may reach where it is
 * going, before anything reads the text: under `air-gapped` only the `local` alias, under `strict-egress` only hosts the workspace
 * allowlisted (a provider on localhost is not egress), under the other two presets everything. The caller resolves the targets (for the LLM
 * gateway: the alias and every link of its fallback chain with the host each reaches) and this plugin judges them. Basic on purpose: the
 * per-team allowlist and the per-team proxy config are phase 10 (P10-04).
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
    events: { emits: ['guardrails.egress.decided'], consumes: [] },
  },
  register(ctx) {
    ctx.hooks.preEgress(async (input, tx): Promise<EgressVerdict | void> => {
      if (!input.targets || input.targets.length === 0) return;
      const preset = presetOf(input.preset);
      const refusal = judgeTargets(preset, input.allowlist ?? [], input.targets);
      if (!refusal) return;
      if (input.recorded !== true) {
        await ctx.audit.emit(tx, {
          type: 'guardrails.egress.decided',
          workspaceId: input.workspaceId,
          destination: input.destination,
          botId: input.botId ?? null,
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
