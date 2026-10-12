import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, WorkspaceId } from '../ids.ts';
import { LlmAliasName } from './llm.ts';

// The LLM gateway's limits vocabulary (PLAN.md P5-07, SPEC §10.1, §15): budgets workspace → team → bot → session, the
// rate limit that sits beside them, and the four guard presets. Every enum here matches a CHECK of the gateway-llm
// plugin's migration 0002_limits.sql, and the enum columns are listed in the kernel's schema-enums map.

/**
 * Where a limit is set (SPEC §10.1 "budgets workspace → team → bot → session"). Every scope that applies to a call must
 * pass; the narrowest one that is exhausted is the one the refusal names.
 */
export const LlmLimitScope = z.enum(['workspace', 'team', 'bot', 'session']);
export type LlmLimitScope = z.infer<typeof LlmLimitScope>;

/**
 * The window a workspace, team or bot budget rolls over in. A session budget covers one session from its first call, so
 * the scope 'session' ignores the window (the row still carries one so the column is never null).
 */
export const LlmBudgetWindow = z.enum(['day', 'month']);
export type LlmBudgetWindow = z.infer<typeof LlmBudgetWindow>;

/** The guard presets of SPEC §15, set once at Workspace → LLM and read before every call. */
export const LlmGuardPreset = z.enum(['standard', 'strict-egress', 'air-gapped', 'customer-facing']);
export type LlmGuardPreset = z.infer<typeof LlmGuardPreset>;

/** What the pre-call hook answered (SPEC §15: `allow`, `redact`, `require_approval`, `block`). */
export const LlmGuardOutcome = z.enum(['allow', 'redact', 'require_approval', 'block']);
export type LlmGuardOutcome = z.infer<typeof LlmGuardOutcome>;

/** Why a call was refused before it left the gateway (the reason the `llm.budget.exceeded` event carries). */
export const LlmRefusalReason = z.enum(['budget', 'rate', 'preset', 'dlp']);
export type LlmRefusalReason = z.infer<typeof LlmRefusalReason>;

/** The workspace-level settings of Workspace → LLM that are not a provider, an alias or a limit. */
export const LlmWorkspaceSettings = z.object({
  preset: LlmGuardPreset,
  /**
   * Hosts the `strict-egress` preset lets a call reach. Empty under `strict-egress` means nothing leaves the box, which
   * is a deliberate choice an admin makes rather than a default.
   */
  egressAllowlist: z.array(z.string().min(1)),
  /** Whether the proxy may answer an identical request from its own cache (SPEC §10.1 "caching"). */
  caching: z.boolean(),
  updatedAt: IsoDateTime,
});
export type LlmWorkspaceSettings = z.infer<typeof LlmWorkspaceSettings>;

/** How a preset treats egress and what the pre-call hook does when it finds sensitive material. */
export interface LlmPresetDefinition {
  label: string;
  summary: string;
  /** `any`: every configured provider; `allowlist`: hosts the workspace listed; `local-only`: the `local` alias only. */
  egress: 'any' | 'allowlist' | 'local-only';
  /** The hook's action on a detection. `require_approval` is a bot's own choice (`guard.rules`: `dlp:require_approval`, P5-20), never a preset's. */
  onDetection: 'redact' | 'block';
}

/**
 * The four presets as data, so the workspace page (P5-08) and the pre-call hook read one definition. The hook itself
 * lives in the gateway (`packages/plugins/gateway-llm/src/dlp.ts`); this record is what it obeys.
 */
export const LLM_GUARD_PRESETS: Record<LlmGuardPreset, LlmPresetDefinition> = {
  standard: {
    label: 'Standard',
    summary: 'Secrets and card numbers are redacted before the call; every configured provider is reachable.',
    egress: 'any',
    onDetection: 'redact',
  },
  'strict-egress': {
    label: 'Strict egress',
    summary: 'As standard, and a call may only reach a host the workspace allowlisted.',
    egress: 'allowlist',
    onDetection: 'redact',
  },
  'air-gapped': {
    label: 'Air-gapped',
    summary: 'Only the local alias runs; nothing else may be called, and detections are redacted.',
    egress: 'local-only',
    onDetection: 'redact',
  },
  'customer-facing': {
    label: 'Customer-facing',
    summary: 'A call that carries a detected secret or card number is refused outright, not sent redacted.',
    egress: 'any',
    onDetection: 'block',
  },
};

/** The presets in the order the workspace page lists them. */
export const LLM_GUARD_PRESET_ORDER: readonly LlmGuardPreset[] = LlmGuardPreset.options;

/** The settings of a workspace that has never saved any: `standard`, no allowlist, caching on. */
export const LLM_DEFAULT_SETTINGS: Omit<LlmWorkspaceSettings, 'updatedAt'> = {
  preset: 'standard',
  egressAllowlist: [],
  caching: true,
};

/**
 * One limit row. A row may carry a spend cap, a rate limit, or both — never neither. `teamId` is set for the team scope,
 * `botId` for the bot and session scopes, and neither for the workspace scope.
 */
export const LlmLimit = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  scope: LlmLimitScope,
  teamId: z.uuid().nullable(),
  botId: BotId.nullable(),
  window: LlmBudgetWindow,
  /** The spend cap in US dollars for the window; null when the row only carries a rate limit. */
  limitUsd: z.number().nonnegative().nullable(),
  /** Calls per minute at this scope; null when the row only carries a spend cap. */
  requestsPerMinute: z.number().int().positive().nullable(),
  updatedAt: IsoDateTime,
});
export type LlmLimit = z.infer<typeof LlmLimit>;

/**
 * One line of `llm_spend`: what one model call cost. Append-only (the application role may insert and read, never change
 * a line), so the ledger is the audit trail of spend as well as the input to a budget check.
 */
export const LlmSpendEntry = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  teamId: z.uuid().nullable(),
  botId: BotId.nullable(),
  /** The runtime's session identifier (a conversation or a run), the target of a session budget; null for a call with none. */
  sessionId: z.string().nullable(),
  runId: z.uuid().nullable(),
  alias: LlmAliasName,
  /** The model the alias resolved to, for the page's detail; never a credential. */
  model: z.string().nullable(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  occurredAt: IsoDateTime,
});
export type LlmSpendEntry = z.infer<typeof LlmSpendEntry>;

/** The spend rolled up for the workspace page: one total and its per-scope breakdown. */
export const LlmSpendSummary = z.object({
  since: IsoDateTime,
  until: IsoDateTime,
  totalUsd: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  byTeam: z.array(z.object({ teamId: z.uuid().nullable(), spentUsd: z.number().nonnegative(), calls: z.number().int().nonnegative() })),
  byBot: z.array(z.object({ botId: BotId.nullable(), spentUsd: z.number().nonnegative(), calls: z.number().int().nonnegative() })),
});
export type LlmSpendSummary = z.infer<typeof LlmSpendSummary>;
