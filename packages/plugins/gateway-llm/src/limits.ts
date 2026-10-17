import type { EgressDecision, EgressMode, EgressTarget as EgressHopTarget, PluginContext, PluginTx } from '@manythreads/sdk';
import {
  LLM_DEFAULT_SETTINGS,
  LlmSpendSummary,
  LlmWorkspaceSettings,
  type LlmAliasName,
  type LlmBudgetWindow,
  type LlmLimitScope,
} from '@manythreads/shared';
import { decide, windowStart, type LlmCallDecision, type LlmScopeSnapshot } from './budget.ts';
import { loadEgress, type EgressTarget } from './egress-targets.ts';
import type { RateHit } from './rate-limit.ts';

export { decide, windowStart } from './budget.ts';
export type { LlmCallDecision, LlmScopeSnapshot } from './budget.ts';
export { createSlidingWindow, rateKey } from './rate-limit.ts';
export type { RateHit } from './rate-limit.ts';
export { loadEgress } from './egress-targets.ts';
export type { EgressTarget } from './egress-targets.ts';

// The enforcement half of the gateway (PLAN P5-07: budgets workspace → team → bot → session and rate limits "enforced
// before the call"; `llm_spend`; the presets; the pre-call DLP hook). The split follows the config half: `decide` is a
// pure function over rows a caller already loaded (so a unit test can assert every ordering rule without a database),
// and `preflight` is the thin part that loads those rows, runs the hook, calls the limiter and records what happened.
// The pure decision lives in `./budget.ts`, the sliding log in `./rate-limit.ts`, the egress targets in
// `./egress-targets.ts`; this module keeps the database half and the preflight orchestration.
//
// Rate limits live in process memory, per replica, never in the database (PLAN D3). The kernel has a limiter of the same
// shape (`packages/kernel/src/transport/rate-limiter.ts`) but a plugin may not import the kernel, so this module carries
// its own; both are a sliding log with the same refusal rule (a refused request is not counted, so backing off recovers
// exactly one window after the last accepted call).

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
