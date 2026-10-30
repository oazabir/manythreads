import type { BotRunHandle, EgressInput, PluginContext } from '@manythreads/sdk';

// The data-loss check at the MCP gateway (PLAN P10-04, SPEC §15). A tool call is a way for text to leave a bot's run: a key pasted into a page, a
// token in a message, a password in a proposal. Before the call runs, every piece of text in its arguments goes through the `pre_egress` chain
// (guardrails-dlp reads it; the workspace's choices decide what a finding means), and the strongest answer wins:
//   * block: the call does not run, and the bot is told what kind of thing it carried (never the thing itself);
//   * redact: the call runs with each finding replaced by a marker;
//   * require_approval: the call waits for a person, and the copy that waits is the redacted one (a secret is never stored in an approval).
// What a read tool answers with is checked the same way before the bot sees it, so a secret that sits in a file or a page does not walk into a model's
// context; there `require_approval` has nobody to ask and counts as a refusal.
//
// Every text value is read, and so is every distinct field name (a name is text too: `{"sk-…": 1}` carries a key). A name cannot be redacted without
// changing what the call means, so a finding in a name refuses the call. What is not read: encodings (base64, hex, url-escapes), text split across several
// values or several calls, and look-alike letters. The event that records a decision is written once per call, with the names of what was found, never the text.

/** Pieces of text one call may hold, their total size, and how deeply nested it may be, before it is refused unread: a bound on the work, and on hostile shapes. */
const LEAVES_MAX = 20_000;
const CHARS_MAX = 8_000_000;
const DEPTH_MAX = 20;
/** An id carries no secret and no personal data, and a long run of digits in one can pass the card checksum by chance: ids are not read. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The preset the gateway judges under. The workspace's own preset is model-gateway settings only an admin can read; the admin's per-detector choices are what decide here. */
const PRESET = 'standard';

export type GuardOutcome = 'allow' | 'redact' | 'require_approval' | 'block';
const ORDER: readonly GuardOutcome[] = ['allow', 'redact', 'require_approval', 'block'];

export interface Guarded {
  outcome: GuardOutcome;
  /** The value to use: the original for `allow` and `block`, the redacted copy for `redact` and `require_approval`. */
  value: unknown;
  /** Detector and rule names, never text. Empty when nothing was found. */
  rules: string[];
  /** True when no guardrail answered (the plugin is missing or the value was too large to read): the call is refused, not waved through. */
  unchecked: boolean;
}

interface Leaf {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  text: string;
}

/** A deep copy of `value`, the text values in it and its distinct field names, or null when it nests too deeply or is too big to read. */
function collect(value: unknown): { copy: unknown; leaves: Leaf[]; names: string[] } | null {
  const leaves: Leaf[] = [];
  const names = new Set<string>();
  let chars = 0;
  const take = (holder: Leaf['holder'], key: string | number, text: string): void => {
    chars += text.length;
    if (UUID.test(text)) return;
    leaves.push({ holder, key, text });
    if (leaves.length > LEAVES_MAX || chars > CHARS_MAX) throw new RangeError('too big');
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string' || typeof node !== 'object' || node === null) return node;
    if (depth > DEPTH_MAX) throw new RangeError('too deep');
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      node.forEach((item, index) => {
        if (typeof item === 'string') {
          out.push(item);
          take(out, index, item);
        } else out.push(walk(item, depth + 1));
      });
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (!names.has(key)) {
        names.add(key);
        chars += key.length;
      }
      if (typeof item === 'string') {
        out[key] = item;
        take(out, key, item);
      } else out[key] = walk(item, depth + 1);
    }
    return out;
  };
  try {
    return { copy: walk(value, 0), leaves, names: [...names].filter((name) => !UUID.test(name)) };
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * Runs the chain over every piece of text in `value`, in one short transaction as the bot (so the policy is read with the bot's own view of the
 * workspace and the decision event is committed whether or not the call goes on). `where` names the direction in the event: `mcp` for what a call
 * carries out, `mcp_result` for what a read answers with.
 */
export async function guardValue(ctx: PluginContext, run: BotRunHandle, value: unknown, where: 'mcp' | 'mcp_result'): Promise<Guarded> {
  // a bare string is guarded as the one value of an object, so there is a place to put its redacted copy
  if (typeof value === 'string') {
    const wrapped = await guardValue(ctx, run, { text: value }, where);
    return { ...wrapped, value: wrapped.outcome === 'allow' || wrapped.outcome === 'block' ? value : (wrapped.value as { text: string }).text };
  }
  const gathered = collect(value);
  if (gathered === null) return { outcome: 'block', value, rules: [], unchecked: true };
  const { copy, leaves, names } = gathered;
  if (leaves.length === 0 && names.length === 0) return { outcome: 'allow', value, rules: [], unchecked: false };

  return ctx.runs.asBot(run, async (tx): Promise<Guarded> => {
    let strongest: GuardOutcome = 'allow';
    const rules: string[] = [];
    let changed = false;
    // field names, read together as one text (one line each): a finding in one refuses the whole call, because a name cannot be hidden without
    // changing what the call means
    if (names.length > 0) {
      const input: EgressInput = { destination: where, workspaceId: run.workspaceId, text: names.join('\n'), preset: PRESET, botId: run.botId, teamId: run.teamId, recorded: true };
      const decision = await ctx.hooks.runPreEgress(tx, input);
      if (decision.hooks === 0 || !decision.ran.includes('guardrails-dlp')) return { outcome: 'block', value, rules: [], unchecked: true };
      if (decision.outcome !== 'allow') {
        for (const rule of decision.rules) if (!rules.includes(rule)) rules.push(rule);
        strongest = 'block';
      }
    }
    for (const leaf of leaves) {
      const input: EgressInput = { destination: where, workspaceId: run.workspaceId, text: leaf.text, preset: PRESET, botId: run.botId, teamId: run.teamId, recorded: true };
      const decision = await ctx.hooks.runPreEgress(tx, input);
      // Nothing guards the text (the data-loss plugin is not loaded): refuse rather than wave it through.
      if (decision.hooks === 0 || !decision.ran.includes('guardrails-dlp')) return { outcome: 'block', value, rules: [], unchecked: true };
      if (decision.outcome === 'allow') continue;
      for (const rule of decision.rules) if (!rules.includes(rule)) rules.push(rule);
      if (ORDER.indexOf(decision.outcome) > ORDER.indexOf(strongest)) strongest = decision.outcome;
      if (decision.outcome !== 'block' && decision.text !== leaf.text) {
        (leaf.holder as Record<string | number, unknown>)[leaf.key] = decision.text;
        changed = true;
      }
    }
    if (strongest === 'allow') return { outcome: 'allow', value, rules, unchecked: false };
    await ctx.audit.emit(tx, {
      type: 'guardrails.dlp.decided',
      workspaceId: run.workspaceId,
      destination: where,
      botId: run.botId,
      teamId: run.teamId,
      preset: PRESET,
      outcome: strongest,
      rules: rules.length > 0 ? rules : ['unnamed'],
      at: ctx.runtime.now().toISOString(),
    });
    return { outcome: strongest, value: strongest === 'block' || !changed ? value : copy, rules, unchecked: false };
  });
}

/** A sentence for the bot: what kind of thing was found, never the thing. */
export function describeFinding(rules: readonly string[]): string {
  if (rules.includes('scan-limit')) return 'more text than the data-loss check can read with the rules this workspace has';
  return rules.length === 0 ? 'text the data-loss policy does not allow' : rules.join(', ');
}
