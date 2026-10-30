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
import { nextLocal } from './config.ts';
import { APPLY_CONFIG_QUEUE } from './gateway.ts';
import { invalid, json, notFound, requireWorkspaceAdmin, route } from './http.ts';
import {
  ALIAS_COLUMNS,
  PROVIDER_COLUMNS,
  toLlmAlias,
  toLlmProvider,
  type AliasRow,
  type ProviderRow,
} from './rows.ts';
import { registerLimitRoutes } from './routes-limits.ts';
import { registerAliasTestRoutes } from './routes-tests.ts';

// Workspace → LLM → Providers & aliases (SPEC §10.1, PLAN P5-06). Admins write the rows; every write ends by enqueuing the
// apply-config job, so the proxy is brought in line in the same transaction the change commits in (the job runs after it).
// Budgets, rate limits, settings and spend live in `./routes-limits.ts`.

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
  registerAliasTestRoutes(ctx);
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
        `INSERT INTO app.llm_providers (workspace_id, name, kind, api_base, api_version, secret_id, enabled, local)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PROVIDER_COLUMNS}`,
        [tx.actor.workspaceId, body.name, body.kind, body.apiBase ?? null, body.apiVersion ?? null, secretId, body.enabled ?? true, body.local ?? false],
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
      const replacesSecret = body.apiKey !== undefined;
      if (body.apiKey !== undefined) secretId = body.apiKey === '' ? null : await ctx.secrets.put(tx, body.apiKey);
      const updated = await tx.query<ProviderRow>(
        `UPDATE app.llm_providers SET name = $2, api_base = $3, api_version = $4, secret_id = $5, enabled = $6, local = $7, updated_at = now()
          WHERE id = $1 RETURNING ${PROVIDER_COLUMNS}`,
        [
          providerId,
          body.name ?? before.name,
          body.apiBase === undefined ? before.api_base : body.apiBase,
          body.apiVersion === undefined ? before.api_version : body.apiVersion,
          secretId,
          body.enabled ?? before.enabled,
          nextLocal(before, body),
        ],
      );
      // The old secret goes only after the row stopped pointing at it (a foreign key); deleting it first refused every key change with a 409.
      if (replacesSecret && before.secret_id) await ctx.secrets.delete(tx, before.secret_id);
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
      // The provider's aliases go with it. Left bound to nothing (the FK would null their provider), they would be pushed to the
      // proxy as models with no key, and every call to them would fail at the provider instead of being refused here. The admin
      // binds them again to another provider; until then the alias is unbound and its bots' keys stop covering it.
      await tx.query('DELETE FROM app.llm_aliases WHERE provider_id = $1', [providerId]);
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
