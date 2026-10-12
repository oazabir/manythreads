// The `pre_egress` extension point (SPEC §3 `hook.pre_egress`, §15; PLAN P5-21). Whatever is about to leave the platform — a model call, a
// channel post to another team, an email — passes the chain of hooks the guardrails plugins registered, and the chain answers one of four
// outcomes: `allow`, `redact`, `require_approval`, `block`. A caller never re-implements a rule: it describes what would leave and obeys the answer.
//
// Types and one pure function (`combineEgress`, the chain's folding rule) live here so a plugin that runs the chain and the kernel that hosts it
// cannot disagree about it. No I/O.

import type { PluginTx } from './types.ts';

/** What the chain answers, weakest first. A later hook can only raise the outcome, never lower it. */
export const EGRESS_OUTCOMES = ['allow', 'redact', 'require_approval', 'block'] as const;
export type EgressOutcome = (typeof EGRESS_OUTCOMES)[number];

/**
 * How a finding is treated (guardrails-dlp reads it):
 *  - `preset`: the workspace preset's own rule (`standard` redacts, `customer-facing` refuses);
 *  - `hold`: the caller asked for a person to see it first, so a finding is `require_approval` and the text is the redacted one;
 *  - `approved`: a person has just approved exactly this call, so a finding is let through as written (never past a preset that refuses).
 */
export type EgressMode = 'preset' | 'hold' | 'approved';

/** One place the call would reach: a link of an alias's chain, or the one host an email goes to. */
export interface EgressTarget {
  /** What the caller calls it (`smart`, a fallback alias). */
  name: string;
  /** The host it reaches, or null when the caller cannot tell (a provider with no base URL). */
  host: string | null;
  /** The machine itself (an Ollama on localhost): not egress. */
  local: boolean;
}

export interface EgressInput {
  /** Where the bytes go: `llm`, `channel`, `email`, `mcp`, ... */
  destination: string;
  workspaceId: string;
  /** The text that would leave; empty when the call carries none (a pure reachability question). */
  text: string;
  /**
   * The workspace guard preset (`standard`, `strict-egress`, `air-gapped`, `customer-facing`). The preset is the caller's to look up
   * (the LLM gateway keeps it with its other settings); a hook that does not know the name treats it as `standard`.
   */
  preset: string;
  /** Hosts a `strict-egress` workspace allows. */
  allowlist?: readonly string[];
  /** Where the call would go, every link included: the rule holds for a fallback chain, not only its first link. */
  targets?: readonly EgressTarget[];
  mode?: EgressMode;
  /** The bot or person on whose behalf it leaves, for the audit trail. */
  botId?: string | null;
  /**
   * True when the caller writes its own decision event (the LLM gateway's `llm.guard.decided`, which knows the alias and the budget). The
   * guardrails plugins then do not write theirs, so one decision is not recorded twice.
   */
  recorded?: boolean;
}

/** What one hook answers. Nothing at all means "no objection". */
export interface EgressVerdict {
  outcome: EgressOutcome;
  /** The text as it may be sent or shown to an approver (redacted). Ignored for `allow` and `block`. */
  text?: string;
  /** Names of what fired (detector names, `air-gapped`), never the matched text. */
  rules?: readonly string[];
  /** Why a refusal is a refusal: `preset` (the workspace's egress rule) or `dlp` (a detection). */
  reason?: 'preset' | 'dlp';
  /** One sentence for a run's log and a conversation. */
  message?: string;
}

export type EgressHook = (input: EgressInput, tx: PluginTx) => EgressVerdict | void | Promise<EgressVerdict | void>;

/** The chain's answer. */
export interface EgressDecision {
  outcome: EgressOutcome;
  /** `allow` and `block`: the input unchanged. `redact` and `require_approval`: the redacted text. */
  text: string;
  rules: string[];
  /** Set for `block` and `require_approval`; `error` is a hook that threw (the chain fails closed). */
  reason: 'preset' | 'dlp' | 'error' | null;
  message: string | null;
  /** How many hooks ran. Zero means nothing guards this destination; a caller that must be guarded refuses. */
  hooks: number;
}

const rank = (outcome: EgressOutcome): number => EGRESS_OUTCOMES.indexOf(outcome);

/**
 * Folds one hook's answer into the running decision: the stronger outcome wins, a redaction's text is what the next hook sees, rules accumulate
 * once each. A `block` keeps the original text (there is nothing to send). Pure.
 */
export function combineEgress(current: EgressDecision, verdict: EgressVerdict, original: string): EgressDecision {
  const outcome = rank(verdict.outcome) > rank(current.outcome) ? verdict.outcome : current.outcome;
  const rules = [...current.rules];
  for (const rule of verdict.rules ?? []) if (!rules.includes(rule)) rules.push(rule);
  const text = outcome === 'block' ? original : verdict.text !== undefined && verdict.outcome !== 'allow' ? verdict.text : current.text;
  const holds = verdict.outcome === 'block' || verdict.outcome === 'require_approval';
  return {
    outcome,
    text,
    rules,
    reason: holds ? (verdict.reason ?? 'preset') : current.reason,
    message: holds ? (verdict.message ?? current.message) : current.message,
    hooks: current.hooks + 1,
  };
}
