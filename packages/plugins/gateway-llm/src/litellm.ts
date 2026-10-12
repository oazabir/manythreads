// The LiteLLM proxy client (SPEC §10.1, PLAN P5-06). One proxy runs in the `manythreads-llm` compose service and the
// gateway plugin owns its config, so this module is the only place that speaks to it. Every call carries the master key as
// a bearer token and is made from a job (system transaction), never from a request: the provider API keys it builds into
// the config are system-only.
//
// The endpoints are the proxy's management API: /model/new, /model/update, /model/delete, /config/update and /key/generate,
// /key/delete (docs.litellm.ai/docs/proxy/model_management, /config_update, /virtual_keys). A client is injectable so tests
// run against a fake transport with no proxy at all.

/**
 * The config document the proxy is fed: one `model_list` entry per bound alias, the `fallbacks` chains, and `deleted` —
 * the aliases that are no longer bound and whose model must go.
 */
export interface LiteLlmConfigDocument {
  model_list: Array<{ model_name: string; litellm_params: Record<string, unknown> }>;
  fallbacks: Array<Record<string, string[]>>;
  deleted: string[];
}

/** What a single management call answered. */
export interface LiteLlmResult {
  status: number;
  body: unknown;
}

/** The transport a test substitutes; the default posts JSON over `fetch`. */
export interface LiteLlmTransport {
  post(path: string, body: unknown): Promise<LiteLlmResult>;
}

export interface LlmGateway {
  /** False when no proxy URL is configured: the caller mints and stores keys locally and logs that nothing was pushed. */
  readonly enabled: boolean;
  /**
   * Pushes the whole document: every bound alias is created or updated, every unbound one of the eight is deleted (the
   * alias set is closed, so the client always knows the universe), then the fallback chains are set. Returns how many
   * models the document named.
   */
  applyConfig(document: LiteLlmConfigDocument): Promise<number>;
  /** Registers a caller-chosen key with the proxy, limited to `aliases`. */
  mintKey(input: { key: string; aliases: readonly string[]; metadata: Record<string, string> }): Promise<void>;
  /** Deletes a key. A key the proxy never had (404) is not an error: revoking twice is a no-op. */
  revokeKey(key: string): Promise<void>;
}

export interface LiteLlmClientOptions {
  baseUrl: string | null;
  masterKey: string | null;
  /** How long one management call may take before it is aborted (default 10 s). */
  timeoutMs?: number;
  /** Test seam; the default posts JSON to `<baseUrl><path>` with the master key. */
  transport?: LiteLlmTransport;
}

/** The default transport: plain `fetch` with a timeout and the master key. Any 2xx is success; the body is best-effort. */
function fetchTransport(baseUrl: string, masterKey: string | null, timeoutMs: number): LiteLlmTransport {
  return {
    async post(path, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(masterKey ? { authorization: `Bearer ${masterKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // A non-JSON error page is still an answer; report the status and the raw text.
        }
        return { status: res.status, body: parsed };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One management failure, with the status and the proxy's message so a dead-lettered job names the cause. */
export class LiteLlmError extends Error {
  readonly status: number;
  constructor(path: string, result: LiteLlmResult) {
    const detail = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    super(`LiteLLM ${path} answered ${result.status}: ${detail.slice(0, 300)}`);
    this.name = 'LiteLlmError';
    this.status = result.status;
  }
}

export function createLiteLlmClient(options: LiteLlmClientOptions): LlmGateway {
  const enabled = Boolean(options.baseUrl);
  const transport = options.transport ?? (options.baseUrl ? fetchTransport(options.baseUrl, options.masterKey, options.timeoutMs ?? 10_000) : undefined);

  const post = async (path: string, body: unknown): Promise<LiteLlmResult> => {
    if (!transport) throw new LiteLlmError(path, { status: 0, body: 'no LiteLLM URL is configured' });
    return transport.post(path, body);
  };
  const ok = (path: string, result: LiteLlmResult): LiteLlmResult => {
    if (result.status < 200 || result.status >= 300) throw new LiteLlmError(path, result);
    return result;
  };

  /** Create or update one model. The proxy answers 400 with "already exists" for a duplicate, which is an update. */
  const upsertEntry = async (entry: LiteLlmConfigDocument['model_list'][number]): Promise<void> => {
    const created = await post('/model/new', entry);
    if (created.status >= 200 && created.status < 300) return;
    if (created.status === 400 || created.status === 409) {
      // The model is already there: /model/update takes the same shape and needs the existing id, which the proxy keys by model_name.
      ok('/model/update', await post('/model/update', entry));
      return;
    }
    throw new LiteLlmError('/model/new', created);
  };

  return {
    enabled,

    async applyConfig(document) {
      for (const entry of document.model_list) await upsertEntry(entry);
      for (const stale of document.deleted ?? []) {
        const result = await post('/model/delete', { model_name: stale });
        // A model the proxy does not have is already the desired state; any other failure is real.
        if (result.status !== 404 && !(result.status === 400 && /not found|does not exist/i.test(String(JSON.stringify(result.body))))) {
          ok('/model/delete', result);
        }
      }
      ok('/config/update', await post('/config/update', { router_settings: { fallbacks: document.fallbacks } }));
      return document.model_list.length;
    },

    async mintKey(input) {
      const result = await post('/key/generate', { key: input.key, models: [...input.aliases], metadata: input.metadata });
      // A retry after a crash mints the same caller-chosen key again; the proxy refusing it as a duplicate is the desired state.
      if (result.status === 400 || result.status === 409) {
        if (/already exists|duplicate|already generated/i.test(String(JSON.stringify(result.body)))) return;
      }
      ok('/key/generate', result);
    },

    async revokeKey(key) {
      const result = await post('/key/delete', { keys: [key] });
      if (result.status === 404) return;
      ok('/key/delete', result);
    },
  };
}
