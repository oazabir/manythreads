import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { LlmProviderKind } from '@manythreads/shared';
import { z } from 'zod';
import { APPLY_CONFIG_QUEUE, gatewayFromEnv } from './gateway.ts';
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
  const fallbacks: LiteLlmConfigDocument['fallbacks'] = [];
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
    if (alias.fallbacks.length > 0) fallbacks.push({ [alias.alias]: [...alias.fallbacks] });
  }
  const bound = new Set(model_list.map((m) => m.model_name));
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
  const counts = { providers: document.model_list.length, aliases: aliases.length, fallbacks: document.fallbacks.length };
  ctx.audit.emit(tx, { type: 'llm.config.applied', workspaceId, ...counts, appliedAt: ctx.runtime.now().toISOString() });
  return { ...counts, pushed };
}

/** The apply-config job: one workspace's config, pushed after any provider or alias change. */
export function registerConfigJob(ctx: PluginContext): void {
  ctx.jobs.register(APPLY_CONFIG_QUEUE, async (payload, tx, job) => {
    const { workspaceId } = WorkspacePayload.parse(payload);
    const result = await pushLlmConfig(ctx, tx, workspaceId);
    if (!result.pushed) job.log.warn('gateway-llm: no LiteLLM URL is configured; the config was recorded but not pushed');
  });
}
