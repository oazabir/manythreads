import { combineEgress, type EgressDecision, type EgressHook, type EgressInput, type PluginTx } from '@manythreads/sdk';
import type { RegistryEntry } from './registries.ts';

/**
 * The `pre_egress` chain (SPEC §15, PLAN P5-21): every registered hook sees the input in load order, with the text the hooks before it
 * left. The strongest outcome wins (`combineEgress`); a `block` ends the chain (nothing after it could change the answer, and a refused
 * call must not be read by more code than needed); a hook that throws blocks, because a guard that failed is not a guard that allowed.
 * The error's message is not passed on (it may quote the text), only that a guard failed.
 */
export async function runEgressChain(
  hooks: readonly RegistryEntry<EgressHook>[],
  input: EgressInput,
  tx: PluginTx,
): Promise<EgressDecision> {
  let decision: EgressDecision = { outcome: 'allow', text: input.text, rules: [], reason: null, message: null, hooks: 0, ran: [] };
  for (const entry of hooks) {
    let verdict: Awaited<ReturnType<EgressHook>>;
    try {
      verdict = await entry.value({ ...input, text: decision.text }, tx);
    } catch {
      return {
        outcome: 'block',
        text: input.text,
        rules: decision.rules,
        reason: 'error',
        message: `The ${entry.plugin} guardrail failed, so the ${input.destination} call was refused.`,
        hooks: decision.hooks + 1,
        ran: [...decision.ran, entry.plugin],
      };
    }
    if (!verdict) {
      decision = { ...decision, hooks: decision.hooks + 1, ran: [...decision.ran, entry.plugin] };
      continue;
    }
    decision = { ...combineEgress(decision, verdict, input.text), ran: [...decision.ran, entry.plugin] };
    if (decision.outcome === 'block') break;
  }
  return decision;
}
