import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  CreateLlmProviderRequest,
  DeleteLlmAliasResponse,
  DeleteLlmProviderResponse,
  ListLlmAliasesResponse,
  ListLlmProvidersResponse,
  LlmAliasPathParams,
  LlmAliasResponse,
  LlmProviderPathParams,
  LlmProviderResponse,
  SetLlmAliasRequest,
  UpdateLlmProviderRequest,
  createLlmProviderRoute,
  deleteLlmAliasRoute,
  deleteLlmProviderRoute,
  listLlmAliasesRoute,
  listLlmProvidersRoute,
  setLlmAliasRoute,
  updateLlmProviderRoute,
} from '@manythreads/shared';
import {
  DeleteLlmLimitResponse,
  ListLlmLimitsResponse,
  LlmLimitPathParams,
  LlmLimitResponse,
  LlmSettingsResponse,
  LlmSpendQuery,
  LlmSpendResponse,
  SetLlmLimitRequest,
  SetLlmSettingsRequest,
  deleteLlmLimitRoute,
  getLlmSettingsRoute,
  listLlmLimitsRoute,
  listLlmSpendRoute,
  setLlmLimitRoute,
  setLlmSettingsRoute,
} from '@manythreads/shared';
import { APPLY_CONFIG_QUEUE } from './gateway.ts';
import { invalid, json, notFound, requireWorkspaceAdmin, route } from './http.ts';
import { loadSettings, spendSummary, windowStart } from './limits.ts';
import {
  ALIAS_COLUMNS,
  LIMIT_COLUMNS,
  PROVIDER_COLUMNS,
  toLlmAlias,
  toLlmLimit,
  toLlmProvider,
  type AliasRow,
  type LlmLimitRow,
  type ProviderRow,
} from './rows.ts';

// Workspace → LLM → Providers & aliases (SPEC §10.1, PLAN P5-06). Admins write the rows; every write ends by enqueuing the
// apply-config job, so the proxy is brought in line in the same transaction the change commits in (the job runs after it).

/** The provider of the caller's workspace, or 404 (another workspace's id answers the same as an unknown one). */
async function requireProvider(tx: PluginTx, providerId: string): Promise<ProviderRow> {
  const res = await tx.query<ProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM app.llm_providers WHERE id = $1`, [providerId]);
  const row = res.rows[0];
  if (!row) throw notFound('No such model provider.');
  return row;
}

/** Every provider or alias write ends here: the change is committed and the proxy is told about it (after that transaction). */
const pushConfig = (ctx: PluginContext, tx: PluginTx): Promise<string> =>
  ctx.jobs.enqueue(tx, APPLY_CONFIG_QUEUE, { workspaceId: tx.actor.workspaceId }, { dedupeKey: `config:${tx.actor.workspaceId}` });

export function registerLlmRoutes(ctx: PluginContext): void {
  registerLimitRoutes(ctx);
  ctx.http.route({
    method: listLlmProvidersRoute.method,
    path: listLlmProvidersRoute.path,
    schema: { response: ListLlmProvidersResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const res = await tx.query<ProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM app.llm_providers ORDER BY created_at, id`);
      return json({ providers: res.rows.map(toLlmProvider) });
    }),
  });

  ctx.http.route({
    method: createLlmProviderRoute.method,
    path: createLlmProviderRoute.path,
    schema: { body: CreateLlmProviderRequest, response: LlmProviderResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = CreateLlmProviderRequest.parse(req.body);
      const secretId = body.apiKey ? await ctx.secrets.put(tx, body.apiKey) : null;
      const created = await tx.query<ProviderRow>(
        `INSERT INTO app.llm_providers (workspace_id, name, kind, api_base, api_version, secret_id, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PROVIDER_COLUMNS}`,
        [tx.actor.workspaceId, body.name, body.kind, body.apiBase ?? null, body.apiVersion ?? null, secretId, body.enabled ?? true],
      );
      await pushConfig(ctx, tx);
      return json({ provider: toLlmProvider(created.rows[0] as ProviderRow) }, 201);
    }),
  });

  ctx.http.route({
    method: updateLlmProviderRoute.method,
    path: updateLlmProviderRoute.path,
    schema: { body: UpdateLlmProviderRequest, response: LlmProviderResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { providerId } = LlmProviderPathParams.parse(req.params);
      const body = UpdateLlmProviderRequest.parse(req.body);
      const before = await requireProvider(tx, providerId);

      // An empty string clears the stored secret; a missing field leaves it alone.
      let secretId = before.secret_id;
      if (body.apiKey !== undefined) {
        if (before.secret_id) await ctx.secrets.delete(tx, before.secret_id);
        secretId = body.apiKey === '' ? null : await ctx.secrets.put(tx, body.apiKey);
      }
      const updated = await tx.query<ProviderRow>(
        `UPDATE app.llm_providers SET name = $2, api_base = $3, api_version = $4, secret_id = $5, enabled = $6, updated_at = now()
          WHERE id = $1 RETURNING ${PROVIDER_COLUMNS}`,
        [
          providerId,
          body.name ?? before.name,
          body.apiBase === undefined ? before.api_base : body.apiBase,
          body.apiVersion === undefined ? before.api_version : body.apiVersion,
          secretId,
          body.enabled ?? before.enabled,
        ],
      );
      await pushConfig(ctx, tx);
      return json({ provider: toLlmProvider(updated.rows[0] as ProviderRow) });
    }),
  });

  ctx.http.route({
    method: deleteLlmProviderRoute.method,
    path: deleteLlmProviderRoute.path,
    schema: { response: DeleteLlmProviderResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { providerId } = LlmProviderPathParams.parse(req.params);
      const before = await requireProvider(tx, providerId);
      // The aliases keep their rows; the FK sets provider_id null, so a bare model string survives and a prefixed one is skipped.
      await tx.query('DELETE FROM app.llm_providers WHERE id = $1', [providerId]);
      if (before.secret_id) await ctx.secrets.delete(tx, before.secret_id);
      await pushConfig(ctx, tx);
      return json({ ok: true as const, deletedAt: ctx.runtime.now().toISOString() });
    }),
  });

  ctx.http.route({
    method: listLlmAliasesRoute.method,
    path: listLlmAliasesRoute.path,
    schema: { response: ListLlmAliasesResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const res = await tx.query<AliasRow>(`SELECT ${ALIAS_COLUMNS} FROM app.llm_aliases ORDER BY alias`);
      return json({ aliases: res.rows.map(toLlmAlias) });
    }),
  });

  ctx.http.route({
    method: setLlmAliasRoute.method,
    path: setLlmAliasRoute.path,
    schema: { body: SetLlmAliasRequest, response: LlmAliasResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { alias } = LlmAliasPathParams.parse(req.params);
      const body = SetLlmAliasRequest.parse(req.body);
      const fallbacks = body.fallbacks ?? [];
      if (fallbacks.includes(alias)) throw invalid('An alias cannot fall back to itself.');

      // A named provider must be this workspace's (RLS refuses another's row anyway; this answers a clear 404 first).
      if (body.providerId) await requireProvider(tx, body.providerId);
      const saved = await tx.query<AliasRow>(
        `INSERT INTO app.llm_aliases AS a (workspace_id, alias, provider_id, model, fallbacks, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (workspace_id, alias) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model,
           fallbacks = EXCLUDED.fallbacks, updated_at = now()
         RETURNING ${ALIAS_COLUMNS}`,
        [tx.actor.workspaceId, alias, body.providerId ?? null, body.model, fallbacks],
      );
      await pushConfig(ctx, tx);
      return json({ alias: toLlmAlias(saved.rows[0] as AliasRow) });
    }),
  });

  ctx.http.route({
    method: deleteLlmAliasRoute.method,
    path: deleteLlmAliasRoute.path,
    schema: { response: DeleteLlmAliasResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { alias } = LlmAliasPathParams.parse(req.params);
      const deleted = await tx.query('DELETE FROM app.llm_aliases WHERE alias = $1 RETURNING alias', [alias]);
      if (deleted.rows.length === 0) throw notFound(`The ${alias} alias is not bound.`);
      await pushConfig(ctx, tx);
      return json({ ok: true as const });
    }),
  });
}

/** The team or bot a limit targets must be this workspace's (RLS hides another's, so this answers a clear 404). */
async function requireTarget(tx: PluginTx, scope: string, teamId: string | null, botId: string | null): Promise<void> {
  if (scope === 'team') {
    if (!teamId) throw invalid('A team limit needs a team.');
    const found = await tx.query('SELECT 1 FROM app.teams WHERE id = $1', [teamId]);
    if (found.rows.length === 0) throw notFound('No such team.');
  }
  if (scope === 'bot' || scope === 'session') {
    if (!botId) throw invalid('A bot or session limit needs a bot.');
    const found = await tx.query('SELECT 1 FROM app.bots WHERE id = $1', [botId]);
    if (found.rows.length === 0) throw notFound('No such bot.');
  }
}

/**
 * Workspace → LLM → Budgets, rate limits, the guard preset and the spend report (SPEC §10.1, PLAN P5-07). Admin-only,
 * like the provider routes: a limit is a workspace-wide policy and the spend report is the admins' observability page.
 */
export function registerLimitRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listLlmLimitsRoute.method,
    path: listLlmLimitsRoute.path,
    schema: { response: ListLlmLimitsResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const res = await tx.query<LlmLimitRow>(`SELECT ${LIMIT_COLUMNS} FROM app.llm_limits ORDER BY scope, created_at`);
      return json({ limits: res.rows.map(toLlmLimit) });
    }),
  });

  ctx.http.route({
    method: setLlmLimitRoute.method,
    path: setLlmLimitRoute.path,
    schema: { body: SetLlmLimitRequest, response: LlmLimitResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = SetLlmLimitRequest.parse(req.body);
      const teamId = body.scope === 'team' ? (body.teamId ?? null) : null;
      const botId = body.scope === 'bot' || body.scope === 'session' ? (body.botId ?? null) : null;
      await requireTarget(tx, body.scope, teamId, botId);

      // One row per target: read it back, then update or insert (the unique index is on an expression, so no ON CONFLICT).
      const existing = (
        await tx.query<LlmLimitRow>(
          `SELECT ${LIMIT_COLUMNS} FROM app.llm_limits
            WHERE workspace_id = $1 AND scope = $2 AND team_id IS NOT DISTINCT FROM $3 AND bot_id IS NOT DISTINCT FROM $4`,
          [tx.actor.workspaceId, body.scope, teamId, botId],
        )
      ).rows[0];
      const limitUsd = body.limitUsd === undefined ? (existing?.limit_usd ?? null) : body.limitUsd;
      const perMinute =
        body.requestsPerMinute === undefined ? (existing?.requests_per_minute ?? null) : body.requestsPerMinute;
      const window = body.window ?? ((existing?.budget_window as 'day' | 'month' | undefined) ?? 'day');
      if (limitUsd === null && perMinute === null) throw invalid('A limit needs a budget, a rate limit, or both.');

      const saved = existing
        ? await tx.query<LlmLimitRow>(
            `UPDATE app.llm_limits SET budget_window = $2, limit_usd = $3, requests_per_minute = $4, updated_at = now()
              WHERE id = $1 RETURNING ${LIMIT_COLUMNS}`,
            [existing.id, window, limitUsd, perMinute],
          )
        : await tx.query<LlmLimitRow>(
            `INSERT INTO app.llm_limits (workspace_id, scope, team_id, bot_id, budget_window, limit_usd, requests_per_minute)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${LIMIT_COLUMNS}`,
            [tx.actor.workspaceId, body.scope, teamId, botId, window, limitUsd, perMinute],
          );
      return json({ limit: toLlmLimit(saved.rows[0] as LlmLimitRow) }, existing ? 200 : 201);
    }),
  });

  ctx.http.route({
    method: deleteLlmLimitRoute.method,
    path: deleteLlmLimitRoute.path,
    schema: { response: DeleteLlmLimitResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const { limitId } = LlmLimitPathParams.parse(req.params);
      const deleted = await tx.query('DELETE FROM app.llm_limits WHERE id = $1 RETURNING id', [limitId]);
      if (deleted.rows.length === 0) throw notFound('No such limit.');
      return json({ ok: true as const });
    }),
  });

  ctx.http.route({
    method: getLlmSettingsRoute.method,
    path: getLlmSettingsRoute.path,
    schema: { response: LlmSettingsResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      return json({ settings: await loadSettings(tx, tx.actor.workspaceId) });
    }),
  });

  ctx.http.route({
    method: setLlmSettingsRoute.method,
    path: setLlmSettingsRoute.path,
    schema: { body: SetLlmSettingsRequest, response: LlmSettingsResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const body = SetLlmSettingsRequest.parse(req.body);
      const before = await loadSettings(tx, tx.actor.workspaceId);
      const settings = {
        preset: body.preset ?? before.preset,
        egressAllowlist: body.egressAllowlist ?? before.egressAllowlist,
        caching: body.caching ?? before.caching,
      };
      const saved = await tx.query<{ preset: string; egress_allowlist: string[]; caching: boolean; updated_at: Date }>(
        `INSERT INTO app.llm_settings AS s (workspace_id, preset, egress_allowlist, caching, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (workspace_id) DO UPDATE SET preset = EXCLUDED.preset, egress_allowlist = EXCLUDED.egress_allowlist,
           caching = EXCLUDED.caching, updated_at = now()
         RETURNING preset, egress_allowlist, caching, updated_at`,
        [tx.actor.workspaceId, settings.preset, settings.egressAllowlist, settings.caching],
      );
      const row = saved.rows[0] as { preset: string; egress_allowlist: string[]; caching: boolean; updated_at: Date };
      return json({
        settings: {
          preset: row.preset,
          egressAllowlist: row.egress_allowlist,
          caching: row.caching,
          updatedAt: row.updated_at.toISOString(),
        },
      });
    }),
  });

  ctx.http.route({
    method: listLlmSpendRoute.method,
    path: listLlmSpendRoute.path,
    schema: { query: LlmSpendQuery, response: LlmSpendResponse },
    handler: route(async (req, tx) => {
      await requireWorkspaceAdmin(tx);
      const query = LlmSpendQuery.parse(req.query);
      const now = ctx.runtime.now();
      const since = query.since ? new Date(query.since) : windowStart('month', now);
      // `until` is exclusive in the query, so the current instant is included by stepping one millisecond past it.
      const until = query.until ? new Date(query.until) : new Date(now.getTime() + 1);
      if (since.getTime() > until.getTime()) throw invalid('The range ends before it starts.');
      return json({ summary: await spendSummary(tx, tx.actor.workspaceId, { since, until }) });
    }),
  });
}
