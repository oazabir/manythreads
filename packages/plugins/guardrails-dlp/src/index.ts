import { definePlugin, type EgressVerdict } from '@manythreads/sdk';
import { LlmGuardPreset } from '@manythreads/shared';
import { inspect } from './dlp.ts';

export { inspect, scan } from './dlp.ts';
export type { DlpFinding, DlpMode, DlpResult } from './dlp.ts';

/**
 * guardrails-dlp (SPEC §15, PLAN P5-21): the content half of the `pre_egress` chain. It looks at the text that would leave —
 * secrets (API keys, bearer tokens, private-key blocks, credential URLs) and card numbers — and answers one of the four outcomes
 * the platform knows. What a finding means is the workspace preset's rule (`standard` redacts, `customer-facing` refuses) unless
 * the caller asked for a person to see it first (`mode: 'hold'` → `require_approval`) or a person just approved exactly this
 * call (`mode: 'approved'`). The LLM gateway runs this chain before every model call; any other destination (a digest that
 * crosses a team boundary, an email) runs the same chain. Pure string work: no database, no network, linear in the text.
 *
 * The decision is written as `guardrails.dlp.decided` (rule names, never the matched text) unless the caller records its own
 * (`input.recorded`: the gateway's `llm.guard.decided` already knows the alias and the bot).
 */
export default definePlugin({
  manifest: {
    name: 'guardrails-dlp',
    version: '0.1.0',
    kind: 'server',
    extends: ['hook.pre_egress', 'event.emit'],
    events: { emits: ['guardrails.dlp.decided'], consumes: [] },
    // Not a data dependency: it fixes the order of the chain. Where a call may go is judged before the content is read, whatever order the
    // plugin directories are scanned in.
    dependsOn: ['guardrails-egress'],
  },
  register(ctx) {
    ctx.hooks.preEgress(async (input, tx): Promise<EgressVerdict | void> => {
      if (input.text === '') return;
      // A preset this plugin does not know is treated as the default rather than as "no rule": unknown must not mean unguarded.
      const parsed = LlmGuardPreset.safeParse(input.preset);
      const preset = parsed.success ? parsed.data : 'standard';
      const result = inspect(input.text, preset, input.mode ?? 'preset');
      if (result.rules.length === 0) return;

      if (result.outcome !== 'allow' && input.recorded !== true) {
        await ctx.audit.emit(tx, {
          type: 'guardrails.dlp.decided',
          workspaceId: input.workspaceId,
          destination: input.destination,
          botId: input.botId ?? null,
          preset,
          outcome: result.outcome,
          rules: result.rules,
          at: ctx.runtime.now().toISOString(),
        });
      }
      if (result.outcome === 'block') {
        return {
          outcome: 'block',
          reason: 'dlp',
          rules: result.rules,
          message: `The ${preset} preset refuses a call that carries ${result.rules.join(', ')}.`,
        };
      }
      if (result.outcome === 'require_approval') {
        return {
          outcome: 'require_approval',
          reason: 'dlp',
          text: result.text,
          rules: result.rules,
          message: `A person has to approve this call first: it carries ${result.rules.join(', ')}.`,
        };
      }
      return { outcome: result.outcome, text: result.text, rules: result.rules };
    });
  },
});
