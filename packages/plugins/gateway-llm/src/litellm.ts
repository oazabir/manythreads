// The LiteLLM proxy client (SPEC §10.1, PLAN P5-06). One proxy runs in the `manythreads-llm` compose service and the
// gateway plugin owns its config, so this module is the only place that speaks to it. Every call carries the master key as
// a bearer token and is made from a job (system transaction), never from a request: the provider API keys it builds into
// the config are system-only.
//
// The endpoints are the proxy's management API: /model/new, /model/update, /model/delete, /model/info, /config/update and
// /key/generate, /key/update, /key/delete (docs.litellm.ai/docs/proxy/model_management, /config_update, /virtual_keys).
// What the real proxy does, as observed against ghcr.io/berriai/litellm:main-stable (packages/plugins/gateway-llm/test/
// litellm.integration.test.ts keeps those observations honest):
//
//  * `POST /model/new` on a `model_name` that already exists is a **200** that adds a second deployment (the proxy then
//    load-balances across both). It is not "already exists". With `model_info.id` set, a repeat of the same id is a 500.
//    So the gateway names every deployment with an id of its own (`mt-<alias>`), lists what the proxy has, and updates or
//    creates by id — a push repeated any number of times leaves one deployment per alias.
//  * `POST /model/update` needs `model_info.id` (400 "model not found" otherwise). `POST /model/delete` takes `{ id }` and
//    answers **400** "not found in db" for an unknown one (never 404, and 422 without an id).
//  * `POST /config/update` refuses (400) any `router_settings` key the config file names, so deploy/compose/litellm.yaml
//    must not name `fallbacks` or every push fails.
//  * `POST /key/generate` of a key that exists is a 200; `/key/update` of an unknown one is a 404; `/key/delete` of an
//    unknown one is a 404. A key whose `models` is `[]` may call **every** model, so the gateway never sends an empty list.
//
// A client is injectable so tests run against a fake transport with no proxy at all.

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

/** The transport a test substitutes; the default speaks JSON over `fetch`. */
export interface LiteLlmTransport {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<LiteLlmResult>;
}

export interface LlmGateway {
  /** False when no proxy URL is configured: the caller mints and stores keys locally and logs that nothing was pushed. */
  readonly enabled: boolean;
  /**
   * Makes the proxy's models the document: every bound alias has exactly one deployment (created, or updated in place by
   * its id), every other deployment of the closed alias set — an unbound alias, a duplicate left by an older push — is
   * deleted, then the fallback chains are set. Repeating it changes nothing. Returns how many models the document named.
   */
  applyConfig(document: LiteLlmConfigDocument): Promise<number>;
  /** Registers a caller-chosen key with the proxy, limited to `aliases` (never empty: an empty list means every model). */
  mintKey(input: { key: string; aliases: readonly string[]; metadata: Record<string, string> }): Promise<void>;
  /** Changes which aliases a key may call. A key the proxy lost (404) is registered again. `aliases` is never empty. */
  updateKey(input: { key: string; aliases: readonly string[]; metadata: Record<string, string> }): Promise<void>;
  /** Deletes a key. A key the proxy never had (404) is not an error: revoking twice is a no-op. */
  revokeKey(key: string): Promise<void>;
}

export interface LiteLlmClientOptions {
  baseUrl: string | null;
  masterKey: string | null;
  /** How long one management call may take before it is aborted (default 10 s). */
  timeoutMs?: number;
  /** Test seam; the default speaks JSON to `<baseUrl><path>` with the master key. */
  transport?: LiteLlmTransport;
}

/** The deployment id the gateway gives an alias's model: ours to choose, stable, and recognisable in the proxy's listing. */
export const deploymentId = (modelName: string): string => `mt-${modelName}`;

/** The default transport: plain `fetch` with a timeout and the master key. Any 2xx is success; the body is best-effort. */
function fetchTransport(baseUrl: string, masterKey: string | null, timeoutMs: number): LiteLlmTransport {
  return {
    async request(method, path, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(masterKey ? { authorization: `Bearer ${masterKey}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

/**
 * The proxy's answer with anything credential-shaped taken out: the proxy echoes request fields in its errors (an
 * `api_key` value, the encrypted blobs of a just-stored model, a virtual key), and this message lands in job logs and
 * dead letters. Keys (`sk-…`), the value of any key-ish field, and any long token-looking run are replaced.
 */
export function scrubProxyDetail(detail: string): string {
  return detail
    .replace(/\\"/g, '"') // a JSON-stringified body escapes its quotes; the field patterns below read plain ones
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_-]?key|key|token|secret|password|authorization)["']?\s*[:=]\s*)(?:"[^"]{0,400}"|'[^']{0,400}'|[^\s,}]{1,400})/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '[redacted]');
}

/** One management failure, with the status and the proxy's (scrubbed) message so a dead-lettered job names the cause. */
export class LiteLlmError extends Error {
  readonly status: number;
  constructor(path: string, result: LiteLlmResult) {
    const detail = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    super(`LiteLLM ${path} answered ${result.status}: ${scrubProxyDetail(detail ?? '').slice(0, 300)}`);
    this.name = 'LiteLlmError';
    this.status = result.status;
  }
}

/** The proxy's "that does not exist" in any of the shapes it uses (a 404, or a 400 whose message says so). */
const isMissing = (result: LiteLlmResult): boolean =>
  result.status === 404 || (result.status === 400 && /not found|does not exist/i.test(JSON.stringify(result.body)));

interface ListedDeployment {
  id: string;
  name: string;
}

/** The closed alias set, which the gateway owns outright: any deployment under one of these names is ours to reconcile. */
const OWNED_NAMES = new Set(['smart', 'fast', 'code', 'local', 'embed', 'vision', 'image', 'transcribe']);

export function createLiteLlmClient(options: LiteLlmClientOptions): LlmGateway {
  const enabled = Boolean(options.baseUrl);
  const transport = options.transport ?? (options.baseUrl ? fetchTransport(options.baseUrl, options.masterKey, options.timeoutMs ?? 10_000) : undefined);

  const send = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<LiteLlmResult> => {
    if (!transport) throw new LiteLlmError(path, { status: 0, body: 'no LiteLLM URL is configured' });
    return transport.request(method, path, body);
  };
  const post = (path: string, body: unknown): Promise<LiteLlmResult> => send('POST', path, body);
  const ok = (path: string, result: LiteLlmResult): LiteLlmResult => {
    if (result.status < 200 || result.status >= 300) throw new LiteLlmError(path, result);
    return result;
  };

  /** Every deployment the proxy has, as (id, model name). */
  const listModels = async (): Promise<ListedDeployment[]> => {
    const res = ok('/model/info', await send('GET', '/model/info'));
    const data = (res.body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new LiteLlmError('/model/info', { status: res.status, body: 'the model listing has no data array' });
    const models: ListedDeployment[] = [];
    for (const item of data as Array<Record<string, unknown>>) {
      const info = item['model_info'] as { id?: unknown } | undefined;
      const id = typeof info?.id === 'string' ? info.id : null;
      const name = typeof item['model_name'] === 'string' ? item['model_name'] : null;
      if (id !== null && name !== null) models.push({ id, name });
    }
    return models;
  };

  /** Create or update one model by its own deployment id. */
  const upsertEntry = async (entry: LiteLlmConfigDocument['model_list'][number], known: ReadonlySet<string>): Promise<void> => {
    const body = { ...entry, model_info: { id: deploymentId(entry.model_name) } };
    if (known.has(body.model_info.id)) {
      ok('/model/update', await post('/model/update', body));
      return;
    }
    const created = await post('/model/new', body);
    if (created.status >= 200 && created.status < 300) return;
    // The listing was stale (another push got there first, or a replica): the id exists now, so this is an update.
    const updated = await post('/model/update', body);
    if (updated.status >= 200 && updated.status < 300) return;
    throw new LiteLlmError('/model/new', created);
  };

  const removeDeployment = async (id: string): Promise<void> => {
    const result = await post('/model/delete', { id });
    // A deployment already gone is the desired state; any other failure is real.
    if (!isMissing(result)) ok('/model/delete', result);
  };

  const keyBody = (input: { key: string; aliases: readonly string[]; metadata: Record<string, string> }) => {
    // `models: []` means "every model" to the proxy — a bot with nothing bound would be handed the whole gateway.
    if (input.aliases.length === 0) throw new Error('refusing to register a proxy key with no aliases: an empty list allows every model');
    return { key: input.key, models: [...input.aliases], metadata: input.metadata };
  };

  return {
    enabled,

    async applyConfig(document) {
      const existing = await listModels();
      const known = new Set(existing.map((m) => m.id));
      const desired = new Set(document.model_list.map((m) => deploymentId(m.model_name)));
      for (const entry of document.model_list) await upsertEntry(entry, known);
      // Anything else the gateway owns goes: an unbound alias, a deployment of a deleted provider, and the duplicates that
      // earlier pushes (which could not name a deployment) left under the same model_name.
      for (const model of existing) {
        const ours = model.id.startsWith('mt-') || OWNED_NAMES.has(model.name);
        if (ours && !desired.has(model.id)) await removeDeployment(model.id);
      }
      ok('/config/update', await post('/config/update', { router_settings: { fallbacks: document.fallbacks } }));
      return document.model_list.length;
    },

    async mintKey(input) {
      const body = keyBody(input);
      // The proxy answers 200 to a repeat of a caller-chosen key; a 400/409 "already exists" (an older proxy) is the same state.
      const result = await post('/key/generate', body);
      if (result.status === 400 || result.status === 409) {
        if (/already exists|duplicate|already generated/i.test(JSON.stringify(result.body))) return;
      }
      ok('/key/generate', result);
    },

    async updateKey(input) {
      const body = keyBody(input);
      const result = await post('/key/update', { key: body.key, models: body.models });
      if (result.status === 404) {
        // The proxy lost its database (or the key): register it again rather than leave the bot without access.
        ok('/key/generate', await post('/key/generate', body));
        return;
      }
      ok('/key/update', result);
    },

    async revokeKey(key) {
      const result = await post('/key/delete', { keys: [key] });
      if (result.status === 404) return;
      ok('/key/delete', result);
    },
  };
}
