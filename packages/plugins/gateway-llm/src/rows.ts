import { LlmAlias, LlmLimit, LlmProvider } from '@manythreads/shared';

// The plugin's mapper for `llm_providers`, `llm_aliases` and `llm_keys`: the only place a row of one of those tables becomes
// a shared entity. Dates are converted here, once, and the row is parsed through the schema on the way out, so a value the
// database's CHECK would have refused can never reach a response.
//
// A `type`, not an `interface`: only an object type alias satisfies `Record<string, unknown>`, the constraint `tx.query` has.

export type ProviderRow = {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  api_base: string | null;
  api_version: string | null;
  secret_id: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};
export const PROVIDER_COLUMNS = 'id, workspace_id, name, kind, api_base, api_version, secret_id, enabled, created_at, updated_at';

export const toLlmProvider = (r: ProviderRow): LlmProvider =>
  LlmProvider.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    kind: r.kind,
    apiBase: r.api_base,
    apiVersion: r.api_version,
    enabled: r.enabled,
    hasSecret: r.secret_id !== null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });

export type AliasRow = {
  alias: string;
  provider_id: string | null;
  model: string;
  fallbacks: string[];
  updated_at: Date;
};
export const ALIAS_COLUMNS = 'alias, provider_id, model, fallbacks, updated_at';

export const toLlmAlias = (r: AliasRow): LlmAlias =>
  LlmAlias.parse({
    alias: r.alias,
    providerId: r.provider_id,
    model: r.model,
    fallbacks: r.fallbacks,
    updatedAt: r.updated_at.toISOString(),
  });

export type KeyRow = {
  bot_id: string;
  workspace_id: string;
  secret_id: string | null;
  key_prefix: string;
  revoked_at: Date | null;
};

export type LlmLimitRow = {
  id: string;
  workspace_id: string;
  scope: string;
  team_id: string | null;
  bot_id: string | null;
  budget_window: string;
  limit_usd: string | null;
  requests_per_minute: number | null;
  updated_at: Date;
};
export const LIMIT_COLUMNS =
  'id, workspace_id, scope, team_id, bot_id, budget_window, limit_usd, requests_per_minute, updated_at';

export const toLlmLimit = (r: LlmLimitRow): LlmLimit =>
  LlmLimit.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    scope: r.scope,
    teamId: r.team_id,
    botId: r.bot_id,
    window: r.budget_window,
    // numeric arrives as a string from the driver (it would lose precision as a float), the entity wants a number.
    limitUsd: r.limit_usd === null ? null : Number(r.limit_usd),
    requestsPerMinute: r.requests_per_minute,
    updatedAt: r.updated_at.toISOString(),
  });
