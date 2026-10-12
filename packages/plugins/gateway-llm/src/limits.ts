import type { EgressDecision, EgressMode, EgressTarget as EgressHopTarget, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  LLM_DEFAULT_SETTINGS,
  LlmAliasName,
  LlmBudgetWindow,
  LlmGuardPreset,
  LlmGuardOutcome,
  LlmProviderKind,
  LlmSpendSummary,
  LlmWorkspaceSettings,
  type LlmLimitScope,
  type LlmRefusalReason,
} from '@manythreads/shared';

// The enforcement half of the gateway (PLAN P5-07: budgets workspace → team → bot → session and rate limits "enforced
// before the call"; `llm_spend`; the presets; the pre-call DLP hook). The split follows the config half: `decide` is a
// pure function over rows a caller already loaded (so a unit test can assert every ordering rule without a database),
// and `preflight` is the thin part that loads those rows, runs the hook, calls the limiter and records what happened.
//
// Rate limits live in process memory, per replica, never in the database (PLAN D3). The kernel has a limiter of the same
// shape (`packages/kernel/src/transport/rate-limiter.ts`) but a plugin may not import the kernel, so this module carries
// its own; both are a sliding log with the same refusal rule (a refused request is not counted, so backing off recovers
// exactly one window after the last accepted call).

/** The wire hosts of the provider kinds that have a fixed one; a kind with `null` needs an `api_base`. */
const PROVIDER_HOSTS: Record<LlmProviderKind, string | null> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  azure: null,
  bedrock: null,
  google: 'generativelanguage.googleapis.com',
  ollama: 'localhost',
  openai_compatible: null,
};

/** The host a bare model string names through its `provider/` prefix (SPEC §10.2: a model may carry its own prefix). */
const MODEL_PREFIX_HOSTS: Record<string, string | null> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com',
  google: 'generativelanguage.googleapis.com',
  ollama: 'localhost',
  azure: null,
  bedrock: null,
};

/** A host that is the machine itself: an `ollama` provider is not egress, so `strict-egress` never blocks it. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Where a call for `alias` would go, as far as the config knows; `host` null when it cannot be told. */
export interface EgressTarget {
  host: string | null;
  local: boolean;
}

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

/** The rate limiter a preflight needs: `hit` counts one call and answers whether it may happen. */
export type RateHit = (key: string, limit: number, windowMs: number) => { allowed: boolean; retryAfterMs: number };

/** The key a limit counts under; the session scope includes the session, so one bot's sessions do not share a bucket. */
export function rateKey(snapshot: LlmScopeSnapshot, sessionId: string | null): string {
  const { scope, teamId, botId } = snapshot.limit;
  if (scope === 'team') return `team:${teamId}`;
  if (scope === 'bot') return `bot:${botId}`;
  if (scope === 'session') return `session:${botId}:${sessionId ?? 'none'}`;
  return 'workspace';
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

// ---------------------------------------------------------------------------------------------------------------------
// The database half: rows in, decision and events out.

export type SettingsRow = { preset: string; egress_allowlist: string[]; caching: boolean; updated_at: Date };
export type LimitQueryRow = {
  id: string;
  scope: string;
  team_id: string | null;
  bot_id: string | null;
  budget_window: string;
  limit_usd: string | null;
  requests_per_minute: number | null;
};

/** The workspace's settings, or the default when no row was ever saved (nothing has to be seeded). */
export async function loadSettings(tx: PluginTx, workspaceId: string): Promise<LlmWorkspaceSettings> {
  const row = (
    await tx.query<SettingsRow>('SELECT preset, egress_allowlist, caching, updated_at FROM app.llm_settings WHERE workspace_id = $1', [
      workspaceId,
    ])
  ).rows[0];
  return LlmWorkspaceSettings.parse(
    row
      ? { preset: row.preset, egressAllowlist: row.egress_allowlist, caching: row.caching, updatedAt: row.updated_at.toISOString() }
      : { ...LLM_DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() },
  );
}

/** Where the alias would reach: the provider's base URL, the kind's fixed host, or the host its model string names. */
export async function loadEgress(tx: PluginTx, workspaceId: string, alias: LlmAliasName): Promise<EgressTarget | null> {
  const row = (
    await tx.query<{ model: string; kind: string | null; api_base: string | null }>(
      `SELECT a.model, p.kind, p.api_base
         FROM app.llm_aliases a LEFT JOIN app.llm_providers p ON p.id = a.provider_id
        WHERE a.workspace_id = $1 AND a.alias = $2`,
      [workspaceId, alias],
    )
  ).rows[0];
  if (!row) return null;
  let host: string | null = null;
  if (row.api_base) {
    try {
      host = new URL(row.api_base).hostname || null;
    } catch {
      host = null;
    }
  } else if (row.kind) {
    host = PROVIDER_HOSTS[row.kind as LlmProviderKind] ?? null;
  } else {
    const prefix = row.model.includes('/') ? (row.model.split('/')[0] as string) : null;
    host = prefix ? (MODEL_PREFIX_HOSTS[prefix] ?? null) : null;
  }
  return { host, local: host !== null && LOCAL_HOSTS.has(host) };
}

/**
 * The aliases a call for `alias` can end up on when the proxy retries it: its fallbacks, their fallbacks and so on (at most
 * the eight aliases there are), each with where it would reach. Only bound aliases are listed — a fallback nobody bound
 * cannot be called, so it cannot egress anything. The alias itself is not in the list.
 */
export async function loadFallbackChain(
  tx: PluginTx,
  workspaceId: string,
  alias: string,
): Promise<{ alias: string; egress: EgressTarget | null }[]> {
  const seen = new Set<string>([alias]);
  const queue: string[] = [alias];
  const chain: { alias: string; egress: EgressTarget | null }[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const row = (
      await tx.query<{ fallbacks: string[] }>('SELECT fallbacks FROM app.llm_aliases WHERE workspace_id = $1 AND alias = $2', [workspaceId, current])
    ).rows[0];
    for (const next of row?.fallbacks ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      const egress = await loadEgress(tx, workspaceId, next as LlmAliasName);
      if (egress !== null) chain.push({ alias: next, egress });
    }
  }
  return chain;
}

/**
 * The limits that apply to one call, narrowest-first, each with the spend already made in its window. A session budget
 * counts the whole session (the session id is the window); a workspace, team or bot budget counts its calendar window.
 */
export async function loadLimits(
  tx: PluginTx,
  workspaceId: string,
  target: { teamId: string | null; botId: string | null; sessionId: string | null },
  now: Date,
): Promise<LlmScopeSnapshot[]> {
  const rows = (
    await tx.query<LimitQueryRow>(
      `SELECT id, scope, team_id, bot_id, budget_window, limit_usd, requests_per_minute
         FROM app.llm_limits
        WHERE workspace_id = $1
          AND (scope = 'workspace'
            OR (scope = 'team' AND team_id = $2)
            OR (scope IN ('bot', 'session') AND bot_id = $3))
        ORDER BY scope`,
      [workspaceId, target.teamId, target.botId],
    )
  ).rows;

  const snapshots: LlmScopeSnapshot[] = [];
  for (const row of rows) {
    const window = row.budget_window as LlmBudgetWindow;
    const scope = row.scope as LlmLimitScope;
    const spent = await scopeSpend(tx, workspaceId, scope, target, window, now);
    snapshots.push({
      limit: {
        id: row.id,
        scope,
        teamId: row.team_id,
        botId: row.bot_id,
        window,
        limitUsd: row.limit_usd === null ? null : Number(row.limit_usd),
        requestsPerMinute: row.requests_per_minute,
      },
      spentUsd: spent,
    });
  }
  return snapshots;
}

/** What one scope has spent: the call's window for workspace/team/bot, the session for the session scope. */
export async function scopeSpend(
  tx: PluginTx,
  workspaceId: string,
  scope: LlmLimitScope,
  target: { teamId: string | null; botId: string | null; sessionId: string | null },
  window: LlmBudgetWindow,
  now: Date,
): Promise<number> {
  if (scope === 'session') {
    const res = await tx.query<{ spent: string }>(
      `SELECT coalesce(sum(cost_usd), 0)::text AS spent FROM app.llm_spend WHERE workspace_id = $1 AND session_id = $2`,
      [workspaceId, target.sessionId],
    );
    return Number(res.rows[0]?.spent ?? 0);
  }
  const since = windowStart(window, now);
  const clause = scope === 'team' ? 'AND team_id = $3' : scope === 'bot' ? 'AND bot_id = $3' : '';
  const params: unknown[] = [workspaceId, since];
  if (scope === 'team') params.push(target.teamId);
  if (scope === 'bot') params.push(target.botId);
  const res = await tx.query<{ spent: string }>(
    `SELECT coalesce(sum(cost_usd), 0)::text AS spent FROM app.llm_spend WHERE workspace_id = $1 AND occurred_at >= $2 ${clause}`,
    params,
  );
  return Number(res.rows[0]?.spent ?? 0);
}

/** One model call's cost, as the runtime reports it after the call. */
export interface LlmSpendRecord {
  workspaceId: string;
  teamId: string | null;
  botId: string | null;
  sessionId: string | null;
  runId: string | null;
  alias: LlmAliasName;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  occurredAt?: Date;
}

/** Append one line to the ledger. Nothing enforces here: the pre-call check is the gate, this is the record. */
export async function recordSpend(tx: PluginTx, record: LlmSpendRecord): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO app.llm_spend (workspace_id, team_id, bot_id, session_id, run_id, alias, model, prompt_tokens, completion_tokens, cost_usd, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, now())) RETURNING id`,
    [
      record.workspaceId,
      record.teamId,
      record.botId,
      record.sessionId,
      record.runId,
      record.alias,
      record.model,
      record.promptTokens,
      record.completionTokens,
      record.costUsd,
      record.occurredAt ?? null,
    ],
  );
  return res.rows[0]?.id ?? '';
}

/** The rolled-up spend the workspace page reads (total plus the per-team and per-bot breakdown). */
export async function spendSummary(
  tx: PluginTx,
  workspaceId: string,
  range: { since: Date; until: Date },
): Promise<LlmSpendSummary> {
  const total = (
    await tx.query<{ total: string; calls: string; prompt_tokens: string; completion_tokens: string }>(
      `SELECT coalesce(sum(cost_usd), 0)::text AS total, count(*)::text AS calls,
              coalesce(sum(prompt_tokens), 0)::text AS prompt_tokens, coalesce(sum(completion_tokens), 0)::text AS completion_tokens
         FROM app.llm_spend WHERE workspace_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
      [workspaceId, range.since, range.until],
    )
  ).rows[0];
  const byTeam = (
    await tx.query<{ team_id: string | null; spent: string; calls: string }>(
      `SELECT team_id, sum(cost_usd)::text AS spent, count(*)::text AS calls FROM app.llm_spend
        WHERE workspace_id = $1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY team_id ORDER BY 2 DESC`,
      [workspaceId, range.since, range.until],
    )
  ).rows;
  const byBot = (
    await tx.query<{ bot_id: string | null; spent: string; calls: string }>(
      `SELECT bot_id, sum(cost_usd)::text AS spent, count(*)::text AS calls FROM app.llm_spend
        WHERE workspace_id = $1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY bot_id ORDER BY 2 DESC`,
      [workspaceId, range.since, range.until],
    )
  ).rows;
  return LlmSpendSummary.parse({
    since: range.since.toISOString(),
    until: range.until.toISOString(),
    totalUsd: Number(total?.total ?? 0),
    calls: Number(total?.calls ?? 0),
    promptTokens: Number(total?.prompt_tokens ?? 0),
    completionTokens: Number(total?.completion_tokens ?? 0),
    byTeam: byTeam.map((r) => ({ teamId: r.team_id, spentUsd: Number(r.spent), calls: Number(r.calls) })),
    byBot: byBot.map((r) => ({ botId: r.bot_id, spentUsd: Number(r.spent), calls: Number(r.calls) })),
  });
}

/** A sliding-window log limiter, per process (PLAN D3). `hit` counts one call; a refused call is not counted. */
export function createSlidingWindow(now: () => number = Date.now): { hit: RateHit; reset: () => void } {
  const buckets = new Map<string, number[]>();
  return {
    hit(key, limit, windowMs) {
      const stamps = buckets.get(key) ?? [];
      const t = now();
      let start = 0;
      while (start < stamps.length && (stamps[start] as number) <= t - windowMs) start++;
      if (start > 0) stamps.splice(0, start);
      if (stamps.length >= limit) {
        buckets.set(key, stamps);
        return { allowed: false, retryAfterMs: Math.max(1, (stamps[0] as number) + windowMs - t) };
      }
      stamps.push(t);
      buckets.set(key, stamps);
      if (buckets.size > 10_000) {
        // A very long-lived process with many targets: drop buckets whose window has passed (cheap sweep, no timer).
        for (const [id, list] of buckets) {
          const last = list[list.length - 1];
          if (last === undefined || t - last >= windowMs) buckets.delete(id);
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

/** The request one runtime makes before it calls a model. Ids come from the run: the gateway trusts its own actor's. */
export interface LlmCallRequest {
  workspaceId: string;
  botId: string | null;
  teamId: string | null;
  sessionId: string | null;
  alias: LlmAliasName;
  /** The text that would leave (the newest user message, or the tools' preamble the runtime names). */
  text: string;
  /** What a DLP finding does (`EgressMode` in the SDK: guardrails-dlp reads it); the preset's own rule when absent. */
  dlpMode?: EgressMode;
}

/**
 * Everything the gateway knows before a call: the preset, the hook, every applicable limit and the rate counters. It
 * emits the two guard events when a call does not leave and then answers the decision to the caller. Runs in a system
 * transaction (the runtime's own — the same trust level `botKey` needs).
 */
export async function preflight(
  ctx: PluginContext,
  tx: PluginTx,
  rate: RateHit,
  request: LlmCallRequest,
): Promise<LlmCallDecision> {
  const now = ctx.runtime.now();
  const settings = await loadSettings(tx, request.workspaceId);
  const egress = await loadEgress(tx, request.workspaceId, request.alias);
  const fallbacks = await loadFallbackChain(tx, request.workspaceId, request.alias);
  const limits = await loadLimits(tx, request.workspaceId, request, now);

  // The guardrails are the `pre_egress` chain (guardrails-egress judges where the call goes, then guardrails-dlp reads what it carries). The
  // gateway describes the call — the alias and every link of its fallback chain with the host each reaches — and obeys the answer. It writes
  // its own decision event below (it knows the alias and the bot), so the guardrails do not write theirs.
  const targets: EgressHopTarget[] = [
    { name: request.alias, host: egress?.host ?? null, local: egress?.local ?? false },
    ...fallbacks.map((link) => ({ name: link.alias, host: link.egress?.host ?? null, local: link.egress?.local ?? false })),
  ];
  const chain = await ctx.hooks.runPreEgress(tx, {
    destination: 'llm',
    workspaceId: request.workspaceId,
    text: request.text,
    preset: settings.preset,
    allowlist: settings.egressAllowlist,
    targets,
    ...(request.dlpMode ? { mode: request.dlpMode } : {}),
    botId: request.botId,
    recorded: true,
  });
  // Nothing guards the destination (neither plugin is loaded): the call is refused, not waved through. The manifest's `dependsOn` makes this
  // unreachable in a running server; a context assembled by hand (a test) must register the guardrails too.
  const guard: EgressDecision =
    chain.hooks === 0
      ? { ...chain, outcome: 'block', reason: 'preset', message: 'No guardrail is loaded, so the call was refused.' }
      : chain;
  const decision = decide({ alias: request.alias, sessionId: request.sessionId, preset: settings.preset, guard, limits, rate });

  if (!decision.allowed && (decision.reason === 'budget' || decision.reason === 'rate')) {
    await ctx.audit.emit(tx, {
      type: 'llm.budget.exceeded',
      workspaceId: request.workspaceId,
      scope: decision.limit?.scope ?? 'workspace',
      teamId: decision.limit?.teamId ?? null,
      botId: request.botId,
      sessionId: request.sessionId,
      reason: decision.reason,
      window: decision.limit?.window ?? null,
      limitUsd: decision.limit?.limitUsd ?? null,
      requestsPerMinute: decision.limit?.requestsPerMinute ?? null,
      spentUsd: decision.spentUsd,
      retryAfterMs: decision.retryAfterMs,
      alias: request.alias,
      at: now.toISOString(),
    });
  } else if (decision.outcome !== 'allow' || !decision.allowed) {
    await ctx.audit.emit(tx, {
      type: 'llm.guard.decided',
      workspaceId: request.workspaceId,
      botId: request.botId,
      alias: request.alias,
      preset: decision.preset,
      outcome: decision.outcome,
      rules: decision.rules,
      reason: decision.reason === 'preset' || decision.reason === 'dlp' ? decision.reason : null,
      at: now.toISOString(),
    });
  }
  return decision;
}
