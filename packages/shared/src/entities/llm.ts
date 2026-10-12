import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { WorkspaceId } from '../ids.ts';

// The LLM gateway's vocabulary (PLAN.md P5-06, SPEC §10.1). Every type here matches a column or a CHECK of the
// gateway-llm plugin's migration 0001_llm.sql. The two enums are the ones the schema-enums test compares against SQL.

/**
 * The eight aliases a bot asks for (SPEC §10.1, PLAN P5-06). A bot's profile names an alias, never a model, so a
 * workspace can move `smart` from one provider to another without touching a single `BOT.md`.
 */
export const LlmAliasName = z.enum(['smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe']);
export type LlmAliasName = z.infer<typeof LlmAliasName>;

/** The eight aliases in the order the workspace page lists them (SPEC §10.1 names them in this order). */
export const LLM_ALIASES: readonly LlmAliasName[] = LlmAliasName.options;

/** What kind of provider a row is; the LiteLLM model prefix a bare `model` is given. */
export const LlmProviderKind = z.enum(['openai', 'anthropic', 'azure', 'bedrock', 'google', 'ollama', 'openai_compatible']);
export type LlmProviderKind = z.infer<typeof LlmProviderKind>;

/**
 * One configured model provider (SPEC §10.1 "Workspace → LLM configures providers"): where the calls go and how they
 * authenticate. The API key itself is never here — it lives in the secret service and only the gateway reads it back.
 */
export const LlmProvider = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  /** The admin's label, e.g. `Anthropic (production)`. */
  name: z.string().min(1),
  kind: LlmProviderKind,
  /** Base URL for a self-hosted or proxied endpoint; null for the provider's own. */
  apiBase: z.string().nullable(),
  /** Azure api-version (or another kind's extra parameter); null when the provider needs none. */
  apiVersion: z.string().nullable(),
  /** Whether the gateway offers this provider's models to the aliases. A disabled provider is skipped at push time. */
  enabled: z.boolean(),
  /**
   * The admin says this endpoint runs inside this deployment and never egresses (an in-cluster Service, a model on the same network). The one
   * source of truth for "local": the `strict-egress` allowlist does not apply to it, the `air-gapped` preset accepts it, and the gate's classifier
   * may use it. Not guessed from the host name (a loopback host is local without it).
   */
  local: z.boolean(),
  /** True when a key is stored for this provider (never the key itself). */
  hasSecret: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LlmProvider = z.infer<typeof LlmProvider>;

/**
 * One alias → model binding, with the fallbacks tried in order when it fails (SPEC §10.1 "fallbacks"). `providerId`
 * is null for a bare model the gateway resolves from the provider named in the model string itself.
 */
export const LlmAlias = z.object({
  alias: LlmAliasName,
  /** The provider the model runs on; null when `model` already carries its provider prefix. */
  providerId: z.uuid().nullable(),
  /** The model string, with or without a provider prefix (`anthropic/claude-sonnet-4` or `gpt-4o-mini`). */
  model: z.string().min(1),
  /** The aliases to fall back to, in order (LiteLLM's `fallbacks`). */
  fallbacks: z.array(LlmAliasName),
  updatedAt: IsoDateTime,
});
export type LlmAlias = z.infer<typeof LlmAlias>;
