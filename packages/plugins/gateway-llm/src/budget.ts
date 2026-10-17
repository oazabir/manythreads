import type { EgressDecision } from '@manythreads/sdk';
import type {
  LlmAliasName,
  LlmBudgetWindow,
  LlmGuardOutcome,
  LlmGuardPreset,
  LlmLimitScope,
  LlmRefusalReason,
} from '@manythreads/shared';
import { rateKey, type RateHit } from './rate-limit.ts';

/** The start of the window a budget rolls over in, in UTC (the server's clock is the referee's clock). */
export function windowStart(window: LlmBudgetWindow, now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  if (window === 'month') start.setUTCDate(1);
  return start;
}

/** One applicable limit plus what the scope has already spent in its window. */
export interface LlmScopeSnapshot {
  limit: {
    id: string;
    scope: LlmLimitScope;
    teamId: string | null;
    botId: string | null;
    window: LlmBudgetWindow;
    limitUsd: number | null;
    requestsPerMinute: number | null;
  };
  /** The spend in the limit's window (for the session scope: the whole session). */
  spentUsd: number;
}

export interface LlmCallDecision {
  allowed: boolean;
  reason: LlmRefusalReason | null;
  /** One sentence a runtime may put in the run's log (and P5-16 may show in the conversation). */
  message: string | null;
  /** What the hook answered; `redact` means `text` was rewritten, `block` means the call is refused. */
  outcome: LlmGuardOutcome;
  preset: LlmGuardPreset;
  /** The text the caller may send: the input, or the redacted text. */
  text: string;
  /** The detectors that fired, never the matched text. */
  rules: string[];
  retryAfterMs: number | null;
  /** The limit whose scope refused the call; null when nothing did. */
  limit: LlmScopeSnapshot['limit'] | null;
  spentUsd: number | null;
}

/** The scope names the refusal message uses, narrowest first (the order the limits are checked in). */
const SCOPE_ORDER: readonly LlmLimitScope[] = ['session', 'bot', 'team', 'workspace'];

const SCOPE_NOUN: Record<LlmLimitScope, string> = {
  session: 'session',
  bot: 'bot',
  team: 'team',
  workspace: 'workspace',
};

const dollars = (value: number): string => `$${value.toFixed(4)}`;

/**
 * The whole pre-call decision, pure: the guardrails' answer (the `pre_egress` chain: the preset's egress rule, then the DLP check — both
 * live in the guardrails plugins since P5-21), then every applicable limit narrowest-first. A refusal names one scope — the narrowest
 * exhausted one — and a `block` from the chain is a refusal of its own. The only impure part is the injected `rate` counter (process
 * memory, not the database).
 */
export function decide(input: {
  alias: LlmAliasName;
  sessionId: string | null;
  preset: LlmGuardPreset;
  /** What the `pre_egress` chain answered for this call. */
  guard: EgressDecision;
  /** The limits that apply to this call, any order; `decide` sorts them narrowest-first. */
  limits: readonly LlmScopeSnapshot[];
  rate: RateHit;
}): LlmCallDecision {
  const { preset, sessionId, guard } = input;
  const base = {
    outcome: guard.outcome,
    preset,
    text: guard.text,
    rules: guard.rules,
    retryAfterMs: null as number | null,
    limit: null as LlmScopeSnapshot['limit'] | null,
    spentUsd: null as number | null,
  };

  // 1. The guardrails. A `block` (the preset's egress rule, a detection the preset refuses, a guard that failed) stops here; so does a hold
  // for a person: the call does not leave, and nothing after it matters until it is approved (the limits are checked again when the approved
  // call comes back through here).
  if (guard.outcome === 'block') {
    return { ...base, allowed: false, reason: guard.reason === 'dlp' ? 'dlp' : 'preset', message: guard.message ?? 'A guardrail refused this call.' };
  }
  if (guard.outcome === 'require_approval') {
    return { ...base, allowed: false, reason: 'dlp', message: guard.message ?? 'A person has to approve this call first.' };
  }

  // 2. Every applicable limit, narrowest scope first, budget then rate at each scope.
  const ordered = [...input.limits].sort((a, b) => SCOPE_ORDER.indexOf(a.limit.scope) - SCOPE_ORDER.indexOf(b.limit.scope));
  for (const snapshot of ordered) {
    const { limitUsd, requestsPerMinute, scope } = snapshot.limit;
    if (limitUsd !== null && snapshot.spentUsd >= limitUsd) {
      return {
        ...base,
        allowed: false,
        reason: 'budget',
        message: `The ${SCOPE_NOUN[scope]} budget is spent: ${dollars(snapshot.spentUsd)} of ${dollars(limitUsd)}.`,
        limit: snapshot.limit,
        spentUsd: snapshot.spentUsd,
      };
    }
    if (requestsPerMinute !== null) {
      const verdict = input.rate(rateKey(snapshot, sessionId), requestsPerMinute, 60_000);
      if (!verdict.allowed) {
        return {
          ...base,
          allowed: false,
          reason: 'rate',
          message: `The ${SCOPE_NOUN[scope]} rate limit of ${requestsPerMinute} calls a minute is reached.`,
          retryAfterMs: verdict.retryAfterMs,
          limit: snapshot.limit,
          spentUsd: snapshot.spentUsd,
        };
      }
    }
  }

  return { ...base, allowed: true, reason: null, message: null };
}
