import { definePlugin, type EgressVerdict } from '@manythreads/sdk';
import { LLM_GUARD_PRESETS, LlmGuardPreset } from '@manythreads/shared';
import { SCAN_LIMIT_RULE, inspect } from './dlp.ts';
import { loadPolicy } from './policy.ts';
import { registerRoutes } from './routes.ts';

export { inspect, scan } from './dlp.ts';
export type { CompiledRule, DlpFinding, DlpMode, DlpPolicySnapshot, DlpResult } from './dlp.ts';

/**
 * guardrails-dlp (SPEC §15, PLAN P5-21): the content half of the `pre_egress` chain. It looks at the text that would leave —
 * secrets (API keys, bearer tokens, private-key blocks, credential URLs, passwords in code), personal data (card numbers, email
 * addresses, phone numbers, IBANs) and the custom patterns an admin wrote — and answers one of the four outcomes the platform knows.
 * What a finding means is the admin's choice for its detector or rule (Settings > Workspace > Data protection) and, where none was
 * made, the workspace preset's rule (`standard` redacts, `customer-facing` refuses), unless the caller asked for a person to see it
 * first (`mode: 'hold'` → `require_approval`) or a person just approved exactly this call (`mode: 'approved'`). The LLM gateway runs this chain before every model call; any other destination (a digest that
 * crosses a team boundary, an email) runs the same chain. Linear in the text; the only database read is the policy, once per transaction.
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
    events: { emits: ['guardrails.dlp.decided', 'guardrails.policy.updated'], consumes: [] },
    migrations: 'migrations',
    // Not a data dependency: it fixes the order of the chain. Where a call may go is judged before the content is read, whatever order the
    // plugin directories are scanned in.
    dependsOn: ['guardrails-egress'],
  },
  register(ctx) {
    registerRoutes(ctx);
    ctx.hooks.preEgress(async (input, tx): Promise<EgressVerdict | void> => {
      if (input.text === '') return;
      // A preset this plugin does not know is treated as the default rather than as "no rule": unknown must not mean unguarded.
      const parsed = LlmGuardPreset.safeParse(input.preset);
      const preset = parsed.success ? parsed.data : 'standard';
      // The workspace's own choices (which detectors are on, what each does, its custom rules), read once per transaction.
      const policy = await loadPolicy(tx, input.workspaceId);
      const result = inspect(input.text, preset, input.mode ?? 'preset', policy);
      if (result.rules.length === 0) return;

      if (result.outcome !== 'allow' && input.recorded !== true) {
        await ctx.audit.emit(tx, {
          type: 'guardrails.dlp.decided',
          workspaceId: input.workspaceId,
          destination: input.destination,
          botId: input.botId ?? null,
          teamId: input.teamId ?? null,
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
          message: result.rules.includes(SCAN_LIMIT_RULE)
            ? 'The text is too large for the data-loss check to read with the rules this workspace has, so it was not let through.'
            : LLM_GUARD_PRESETS[preset].onDetection === 'block'
              ? `The ${preset} preset refuses a call that carries ${result.rules.join(', ')}.`
              : `The data-loss policy does not let a call that carries ${result.rules.join(', ')} leave.`,
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
