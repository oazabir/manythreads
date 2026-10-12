import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { LlmProviderKind } from '@manythreads/shared';
import { z } from 'zod';
import { APPLY_CONFIG_QUEUE, gatewayFromEnv } from './gateway.ts';
import { syncWorkspaceKeys } from './keys.ts';
import type { LiteLlmConfigDocument } from './litellm.ts';
import { ALIAS_COLUMNS, PROVIDER_COLUMNS, type AliasRow, type ProviderRow } from './rows.ts';

// The config half of the gateway (PLAN P5-06: "config from the DB — providers, aliases … , fallbacks"). The database is the
// source of truth; this module turns its rows into the LiteLLM document and pushes it. The builder is pure so a test can
// assert the document without a database or a proxy; only `applyConfig` reads rows and decrypts keys.

/** The LiteLLM provider prefix a bare model name is given, by our provider kind. */
const PROVIDER_PREFIX: Record<z.infer<typeof LlmProviderKind>, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  azure: 'azure',
  bedrock: 'bedrock',
  google: 'gemini',
  ollama: 'ollama',
  openai_compatible: 'openai',
};

/** The aliases bound in a workspace; the other members of the closed set are pushed as deletions. */
export const ALL_ALIASES: readonly string[] = ['smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe'];

/** `anthropic/claude-sonnet-4` stays as written; `gpt-4o-mini` gains the provider's prefix. */
export function resolveModel(kind: string, model: string): string {
  if (model.includes('/')) return model;
  const prefix = PROVIDER_PREFIX[kind as z.infer<typeof LlmProviderKind>] ?? 'openai';
  return `${prefix}/${model}`;
}

/**
 * The document the proxy is fed. A provider that is disabled (or missing) is skipped, and any alias bound to it is pushed
 * as a deletion, so turning a provider off removes its models rather than leaving them live. `keyFor` answers a provider's
 * decrypted API key; a keyless endpoint (a local Ollama) simply answers null.
 */
export function buildConfigDocument(input: {
  providers: readonly ProviderRow[];
  aliases: readonly AliasRow[];
  keyFor: (providerId: string) => string | null;
}): LiteLlmConfigDocument {
  const byId = new Map(input.providers.filter((p) => p.enabled).map((p) => [p.id, p]));
  const model_list: LiteLlmConfigDocument['model_list'] = [];
  const chains: Array<[string, readonly string[]]> = [];
  for (const alias of input.aliases) {
    const provider = alias.provider_id ? byId.get(alias.provider_id) : undefined;
    // A bare model (`anthropic/claude-...`) needs no provider row; one that names a provider needs it live.
    if (alias.provider_id && !provider) continue;
    const key = provider ? input.keyFor(provider.id) : null;
    model_list.push({
      model_name: alias.alias,
      litellm_params: {
        model: provider ? resolveModel(provider.kind, alias.model) : alias.model,
        ...(key ? { api_key: key } : {}),
        ...(provider?.api_base ? { api_base: provider.api_base } : {}),
        ...(provider?.api_version ? { api_version: provider.api_version } : {}),
      },
    });
    if (alias.fallbacks.length > 0) chains.push([alias.alias, alias.fallbacks]);
  }
  const bound = new Set(model_list.map((m) => m.model_name));
  // A chain names only aliases the proxy has: a fallback to an unbound alias (or one whose provider is off or gone) would fail
  // the call it was meant to rescue.
  const fallbacks: LiteLlmConfigDocument['fallbacks'] = [];
  for (const [alias, chain] of chains) {
    const live = chain.filter((name) => bound.has(name));
    if (live.length > 0) fallbacks.push({ [alias]: live });
  }
  return { model_list, fallbacks, deleted: ALL_ALIASES.filter((alias) => !bound.has(alias)) };
}

const WorkspacePayload = z.object({ workspaceId: z.uuid() });

/**
 * Reads the workspace's rows, decrypts each enabled provider's key and pushes the document. Runs as the system actor (the
 * job transaction), which is also what `ctx.secrets.get` requires. Answers the counts the audit event carries.
 */
export async function pushLlmConfig(
  ctx: PluginContext,
  tx: PluginTx,
  workspaceId: string,
): Promise<{ providers: number; aliases: number; fallbacks: number; pushed: boolean }> {
  const providers = (
    await tx.query<ProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM app.llm_providers WHERE workspace_id = $1 ORDER BY created_at, id`, [
      workspaceId,
    ])
  ).rows;
  const aliases = (
    await tx.query<AliasRow>(`SELECT ${ALIAS_COLUMNS} FROM app.llm_aliases WHERE workspace_id = $1 ORDER BY alias`, [workspaceId])
  ).rows;

  const keys = new Map<string, string | null>();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    keys.set(provider.id, provider.secret_id ? await ctx.secrets.get(tx, provider.secret_id) : null);
  }
  const document = buildConfigDocument({ providers, aliases, keyFor: (id) => keys.get(id) ?? null });

  const gateway = gatewayFromEnv();
  const pushed = gateway.enabled;
  if (pushed) await gateway.applyConfig(document);
  // Which aliases are bound decides which keys exist and what each may call: a bot that waited for its alias gets its key now,
  // and one whose alias was unbound loses access in the same job.
  await syncWorkspaceKeys(ctx, tx, workspaceId);
  const counts = { providers: document.model_list.length, aliases: aliases.length, fallbacks: document.fallbacks.length };
  await ctx.audit.emit(tx, { type: 'llm.config.applied', workspaceId, ...counts, appliedAt: ctx.runtime.now().toISOString() });
  return { ...counts, pushed };
}

/**
 * A short fingerprint of everything the pushed document is built from (providers, their secrets by id, aliases and their
 * chains). Deleted rows change it too. Cheap, and it never reads a secret.
 */
export async function configFingerprint(tx: PluginTx, workspaceId: string): Promise<string> {
  const res = await tx.query<{ fp: string }>(
    `SELECT md5(
       coalesce((SELECT string_agg(concat_ws('|', id, name, kind, api_base, api_version, secret_id, enabled, updated_at), ';' ORDER BY id)
                   FROM app.llm_providers WHERE workspace_id = $1), '')
       || '#' ||
       coalesce((SELECT string_agg(concat_ws('|', alias, provider_id, model, array_to_string(fallbacks, ','), updated_at), ';' ORDER BY alias)
                   FROM app.llm_aliases WHERE workspace_id = $1), '')
     ) AS fp`,
    [workspaceId],
  );
  return res.rows[0]?.fp ?? '';
}

/**
 * The apply-config job: one workspace's config, pushed after any provider or alias change. A change committed while this job
 * runs is not lost: the routes' dedupe key means an enqueue during a run joins the run that is already going, and that run may
 * have read its rows before the change. So the job fingerprints the rows before and after its push, and when they differ it
 * queues one follow-up (under its own key, since this job still holds the routes' key). The daily reconcile covers the last
 * sliver — a change landing between the second fingerprint and the job's commit.
 */
export function registerConfigJob(ctx: PluginContext): void {
  ctx.jobs.register(APPLY_CONFIG_QUEUE, async (payload, tx, job) => {
    const { workspaceId } = WorkspacePayload.parse(payload);
    const before = await configFingerprint(tx, workspaceId);
    const result = await pushLlmConfig(ctx, tx, workspaceId);
    if (!result.pushed) job.log.warn('gateway-llm: no LiteLLM URL is configured; the config was recorded but not pushed');
    const after = await configFingerprint(tx, workspaceId);
    if (after !== before) {
      job.log.info('gateway-llm: the config changed while it was being pushed; pushing again');
      await ctx.jobs.enqueue(tx, APPLY_CONFIG_QUEUE, { workspaceId }, { dedupeKey: `config:${workspaceId}:follow:${after}` });
    }
  });
}

/**
 * The `local` flag after an update. It is the admin's word that an endpoint runs inside this deployment, given for one address: when the base URL
 * changes and the request does not say `local` itself, the word no longer covers the new address and the flag is cleared.
 */
export function nextLocal(before: { local: boolean; api_base: string | null }, body: { local?: boolean; apiBase?: string | null }): boolean {
  if (body.local !== undefined) return body.local;
  if (body.apiBase !== undefined && body.apiBase !== before.api_base) return false;
  return before.local;
}
