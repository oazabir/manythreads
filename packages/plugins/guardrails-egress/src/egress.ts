import { LlmGuardPreset } from '@manythreads/shared';
import type { EgressTarget } from '@manythreads/sdk';

// The egress rule of the presets (SPEC §10.1, §15; PLAN P5-21), moved out of the LLM gateway so every destination answers to the same
// one: `air-gapped` reaches only the `local` alias **and only when that alias really is a model on this machine** (it judges the host, not the name), `strict-egress` only a host the workspace allowlisted (the machine itself is never
// egress), and `standard` and `customer-facing` do not restrict where a call goes. Pure: it judges targets the caller already resolved.

export interface EgressRefusal {
  /** The target the rule judged. */
  target: string;
  /** Where it would have gone, when the caller knew. */
  host: string | null;
  message: string;
}

/**
 * The first target the preset refuses, or null when all may be reached. `targets[0]` is the call's own target; the rest are the links of
 * its fallback chain, which the rule holds for too: the proxy retries a failed call on the next link, so a chain that ends in a hosted model
 * reaches the internet even when its first link is local.
 */
export function judgeTargets(preset: LlmGuardPreset, allowlist: readonly string[], targets: readonly EgressTarget[]): EgressRefusal | null {
  const first = targets[0];
  for (const link of targets) {
    if (preset === 'air-gapped' && link.name !== 'local') {
      return {
        target: link.name,
        host: link.host,
        message:
          link === first
            ? `The air-gapped preset allows only the local alias, and this call asks for ${link.name}.`
            : `The air-gapped preset allows only the local alias, and ${first?.name ?? 'this call'} falls back to ${link.name}.`,
      };
    }
    // The name is not the guarantee: an admin can bind `local` to a hosted provider. Air-gapped judges where the call really goes.
    if (preset === 'air-gapped' && !link.local) {
      return {
        target: link.name,
        host: link.host,
        message: `The air-gapped preset allows only a model on this machine, and the local alias goes to ${link.host ?? 'a host that cannot be told'}.`,
      };
    }
    if (preset === 'strict-egress' && !link.local) {
      const host = link.host;
      const allowed = host !== null && allowlist.some((entry) => entry.toLowerCase() === host.toLowerCase());
      if (!allowed) {
        const via = link === first ? link.name : `${link.name} (a fallback of ${first?.name ?? 'this call'})`;
        return {
          target: link.name,
          host,
          message: host
            ? `The strict-egress preset does not allow ${host}; an admin must add it to the workspace's allowlist.`
            : `The strict-egress preset cannot tell where the ${via} alias goes; an admin must give its provider a base URL.`,
        };
      }
    }
  }
  return null;
}

/** A preset name this plugin does not know is the default, not "no rule" (unknown must not mean unguarded). */
export const presetOf = (name: string): LlmGuardPreset => {
  const parsed = LlmGuardPreset.safeParse(name);
  return parsed.success ? parsed.data : 'standard';
};
