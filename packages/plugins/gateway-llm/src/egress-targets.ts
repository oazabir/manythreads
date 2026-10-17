import type { PluginTx } from '@manythreads/sdk';
import type { LlmAliasName, LlmProviderKind } from '@manythreads/shared';

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

/** A host that is the machine itself: an `ollama` provider on loopback is not egress, so `strict-egress` never blocks it. A provider elsewhere is local only if the admin marked it (`llm_providers.local`). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Where a call for `alias` would go, as far as the config knows; `host` null when it cannot be told. */
export interface EgressTarget {
  host: string | null;
  local: boolean;
}

/** Where the alias would reach: the provider's base URL, the kind's fixed host, or the host its model string names. */
export async function loadEgress(tx: PluginTx, workspaceId: string, alias: LlmAliasName): Promise<EgressTarget | null> {
  const row = (
    await tx.query<{ model: string; kind: string | null; api_base: string | null; provider_local: boolean | null }>(
      `SELECT a.model, p.kind, p.api_base, p.local AS provider_local
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
  // One source of truth for "local" (strict-egress, air-gapped and the gate's classifier all read this): the admin's word for a provider
  // ("runs inside this deployment"), or a loopback host. An unknown host is not local, and nothing is inferred from a name like `*.svc`.
  return { host, local: row.provider_local === true || (host !== null && LOCAL_HOSTS.has(host)) };
}
