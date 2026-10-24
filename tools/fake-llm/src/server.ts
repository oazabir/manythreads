import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { demoScenarioCompletion } from './scenario.ts';

/*
 * fake-llm — a LiteLLM proxy that is not LiteLLM (PLAN P5-08, `tools/fake-llm`).
 *
 * The gateway plugin drives a real LiteLLM proxy over HTTP with a master key, and a client tested only against an
 * injected transport proves nothing about the wire. This is that server: it speaks the management endpoints the client uses
 * (`/model/new`, `/model/update`, `/model/delete`, `/model/info`, `/config/update`, `/key/generate`, `/key/update`,
 * `/key/info`, `/key/delete`), enforces the master key, and keeps its state in memory so a test can read back what the
 * client actually sent.
 *
 * It reproduces the real proxy's habits, observed against ghcr.io/berriai/litellm:main-stable (the env-gated
 * `litellm.integration.test.ts` in gateway-llm re-checks them), because they are what the client's logic exists for:
 *  - creating a model whose `model_name` exists is a **200 that adds a second deployment** (not an error), and a repeat of an
 *    explicit `model_info.id` is a 500;
 *  - updating needs `model_info.id` (400 "model not found" otherwise); deleting takes `{ id }` and answers 400 for an unknown
 *    one (422 without an id), never 404;
 *  - a `/config/update` for `router_settings.fallbacks` is refused (400) when the config file names it (`fallbacksLocked`);
 *  - `/key/generate` of an existing key is a 200 that replaces it; `/key/update` and `/key/delete` of an unknown key are 404;
 *    a key whose `models` is `[]` is allowed every model.
 * A fake that answered 200 to everything would pass while the real thing failed.
 *
 * The same object is the dev stand-in: `src/cli.ts` runs it on a port and `MANYTHREADS_LITELLM_URL` pointed at it gives
 * a workspace real config pushes and key minting without a model provider or an API key.
 */

export interface FakeLlmKey {
  models: string[];
  metadata: Record<string, string>;
}

export interface FakeLlmCall {
  method: string;
  path: string;
  body: unknown;
  /** False when the call was refused for a missing or wrong master key — a test asserts that the refusal happened. */
  authorized: boolean;
}

export interface FakeLlmDeployment {
  id: string;
  model_name: string;
  litellm_params: Record<string, unknown>;
}

export interface FakeLlmState {
  /** The deployments, keyed by `model_info.id` as the proxy keys them (several may share a `model_name`). */
  models: Map<string, FakeLlmDeployment>;
  keys: Map<string, FakeLlmKey>;
  /** The fallback chains from the last `/config/update`. */
  fallbacks: Array<Record<string, string[]>>;
  /** Every request in order, including the refused ones. */
  calls: FakeLlmCall[];
}

export interface FakeLlm {
  /** `http://127.0.0.1:<port>` — what `MANYTHREADS_LITELLM_URL` takes. */
  readonly url: string;
  readonly state: FakeLlmState;
  close(): Promise<void>;
}

export interface FakeLlmOptions {
  /** When set, the management endpoints require `Authorization: Bearer <masterKey>`; anything else is a 401. */
  masterKey?: string;
  /** 0 (the default) asks the OS for a free port, which is what a test wants. */
  port?: number;
  host?: string;
  /** Called after a request is recorded and before it is answered: a test changes the world while the client is mid-push. */
  beforeRespond?: (call: FakeLlmCall) => Promise<void> | void;
  /** Behave as a proxy whose config file names `router_settings.fallbacks`: `/config/update` for it answers 400. */
  fallbacksLocked?: boolean;
  /**
   * When `'demo'`, chat completions are answered by the deterministic bot-chain
   * scenario (`scenario.ts`: orchestrator/coder/tester/brain) instead of the
   * canned sentence — unless `completion` is also set, which wins. The CLI sets
   * this with `--scenario demo` / `FAKE_LLM_SCENARIO=demo`.
   */
  scenario?: 'demo';
  /**
   * What a chat completion answers (default: a canned sentence). A string is the assistant's text; `{ status, body }` is a raw answer
   * (a 500 to prove a caller's error path). A test makes the classifier of the gate (PLAN P5-11) say yes or no with this, and reads what it
   * was sent from `state.calls`.
   */
  completion?: (request: { model: string; messages: Array<{ role: string; content: string }>; authorized: boolean }) => string | { status: number; body: unknown } | Promise<string | { status: number; body: unknown }>;
  /**
   * A real OpenAI-compatible gateway to send chat completions to, instead of answering them. The management endpoints stay in
   * memory, so a dev box can run a real agent against a real model while the platform still owns only a stand-in's config and
   * keys: nothing this server's owner does reaches the upstream's own settings. `model` renames what is sent (manythreads'
   * aliases, `smart` and the like, are not the upstream's names), and `apiKey` is the upstream's bearer — held here, never
   * stored in `state`, never logged.
   */
  upstream?: { url: string; apiKey?: string; model?: string; timeoutMs?: number };
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/** The proxy's error shape: a message under `error`, which is what the client's duplicate detection reads. */
const hasKey = (value: unknown, name: string): boolean =>
  Array.isArray(value)
    ? value.some((v) => hasKey(v, name))
    : typeof value === 'object' && value !== null && Object.entries(value).some(([k, v]) => k === name || hasKey(v, name));

const error = (res: ServerResponse, status: number, message: string): void => json(res, status, { error: { message } });

/**
 * Pass one chat completion to the real gateway and stream its answer back unchanged. Bytes are piped rather than parsed: the
 * agent's own client reads the SSE frames, and rewriting them would test this file instead of the model. The status and the
 * `content-type` go through too, so a refusal from upstream is a refusal here.
 */
async function forwardCompletion(
  upstream: NonNullable<FakeLlmOptions['upstream']>,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const base = upstream.url.replace(/\/+$/, '');
  const url = `${base}${/\/v1$/.test(base) ? '' : '/v1'}/chat/completions`;
  const payload = asObject(body);
  const outbound = upstream.model ? { ...payload, model: upstream.model } : payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstream.timeoutMs ?? 300_000);
  // The caller hanging up (a stopped run) must stop the upstream call too: a model turn nobody will read is money.
  res.once('close', () => controller.abort());
  try {
    const answer = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}),
        // A gateway behind a CDN/WAF rejects the OpenAI SDK's identifying headers; a plain client name passes.
        'user-agent': 'manythreads-fake-llm',
        accept: req.headers.accept ?? 'application/json',
      },
      body: JSON.stringify(outbound),
      signal: controller.signal,
    });
    const type = answer.headers.get('content-type') ?? 'application/json';
    res.writeHead(answer.status, { 'content-type': type, 'cache-control': 'no-store' });
    if (answer.body) {
      // `Readable.fromWeb` is the one bridge from fetch's WHATWG stream to a node response.
      Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      return;
    }
    res.end();
  } catch (err) {
    // Nothing answered upstream (down, DNS, refused, timed out): say so, rather than letting the agent read a 200 with no frames.
    if (!res.headersSent) error(res, 502, `upstream ${upstream.url} could not be reached: ${err instanceof Error ? err.name : 'unknown'}`);
    else res.destroy();
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const asObject = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function startFakeLlm(options: FakeLlmOptions = {}): Promise<FakeLlm> {
  const state: FakeLlmState = { models: new Map(), keys: new Map(), fallbacks: [], calls: [] };
  const masterKey = options.masterKey ?? null;
  let modelSeq = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : undefined;
      const authorization = req.headers.authorization ?? '';
      const authorized = masterKey === null || authorization === `Bearer ${masterKey}`;

      // Health is open: a probe should not need the master key, and the gateway's own readiness check does not send one.
      if (path.startsWith('/health')) {
        state.calls.push({ method: req.method ?? 'GET', path, body, authorized: true });
        return json(res, 200, path.includes('readiness') ? { status: 'healthy', db: 'connected' } : { status: 'healthy' });
      }

      const recorded: FakeLlmCall = { method: req.method ?? 'GET', path, body, authorized };
      state.calls.push(recorded);
      await options.beforeRespond?.(recorded);

      // The real proxy refuses any body that carries a `workspace_id` key, at any depth (it reads it as a client-side passthrough).
      if (
        authorized &&
        (path === '/key/generate' || path === '/key/update' || path === '/chat/completions' || path === '/v1/chat/completions') &&
        hasKey(body, 'workspace_id')
      ) {
        return error(
          res,
          401,
          'workspace_id is not allowed in request body. Clientside passthrough requires explicit admin opt-in. Contact your admin to enable this feature.',
        );
      }

      // A test inspects the proxy through this, which is why it needs the key like any other management call.
      if (path === '/state' && req.method === 'GET') {
        if (!authorized) return error(res, 401, 'invalid key');
        return json(res, 200, {
          models: [...state.models.values()],
          keys: [...state.keys.entries()].map(([key, v]) => ({ key, ...v })),
          fallbacks: state.fallbacks,
          calls: state.calls.length,
        });
      }

      const management = path.startsWith('/model/') || path.startsWith('/v2/model/') || path === '/config/update' || path.startsWith('/key/');
      if (management && !authorized) return error(res, 401, 'invalid key');

      if (path === '/model/new') {
        const entry = asObject(body);
        const name = str(entry['model_name']);
        if (name === '') return error(res, 400, 'model_name is required');
        const requested = str(asObject(entry['model_info'])['id']);
        const id = requested !== '' ? requested : `model-${++modelSeq}`;
        // A repeated explicit id collides on the proxy's primary key; a repeated *name* is simply another deployment.
        if (state.models.has(id)) return json(res, 500, { error: { message: "{'error': 'Failed to add model to db. Check your server logs for more details.'}", type: 'auth_error', param: 'None', code: '500' } });
        state.models.set(id, { id, model_name: name, litellm_params: asObject(entry['litellm_params']) });
        return json(res, 200, { model_id: id, model_name: name });
      }

      if (path === '/model/update') {
        const entry = asObject(body);
        const id = str(asObject(entry['model_info'])['id']);
        const current = state.models.get(id);
        if (id === '' || !current) return error(res, 400, 'Authentication Error, model not found');
        state.models.set(id, {
          id,
          model_name: str(entry['model_name']) || current.model_name,
          litellm_params: { ...current.litellm_params, ...asObject(entry['litellm_params']) },
        });
        return json(res, 200, { model_id: id });
      }

      if (path === '/model/delete') {
        const id = str(asObject(body)['id']);
        if (id === '') return json(res, 422, { detail: [{ type: 'missing', loc: ['body', 'id'], msg: 'Field required' }] });
        if (!state.models.delete(id)) return error(res, 400, `{'error': 'Model with id=${id} not found in db'}`);
        return json(res, 200, { message: `Model: ${id} deleted successfully` });
      }

      if ((path === '/model/info' || path === '/v2/model/info') && req.method === 'GET') {
        // The listing never carries a provider key, as the real one redacts them.
        return json(res, 200, {
          data: [...state.models.values()].map((m) => ({
            model_name: m.model_name,
            litellm_params: Object.fromEntries(Object.entries(m.litellm_params).filter(([k]) => k !== 'api_key')),
            model_info: { id: m.id, db_model: true },
          })),
        });
      }

      if (path === '/config/update') {
        const router = asObject(asObject(body)['router_settings']);
        const fallbacks = router['fallbacks'];
        if (Array.isArray(fallbacks)) {
          if (options.fallbacksLocked) {
            return error(res, 400, "{'error': \"router_settings key 'fallbacks' is set in the config file and cannot be changed here.\"}");
          }
          state.fallbacks = fallbacks as Array<Record<string, string[]>>;
        }
        return json(res, 200, { message: 'Config updated successfully' });
      }

      if (path === '/key/generate') {
        const key = str(asObject(body)['key']);
        if (key === '') return error(res, 400, 'key is required');
        const models = asObject(body)['models'];
        const metadata = asObject(asObject(body)['metadata']);
        // The real proxy answers 200 to a key it already has (and replaces it).
        state.keys.set(key, {
          models: Array.isArray(models) ? models.map(String) : [],
          metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
        });
        return json(res, 200, { key, token: key });
      }

      if (path === '/key/update') {
        const key = str(asObject(body)['key']);
        const current = state.keys.get(key);
        if (!current) return json(res, 404, { error: { message: 'Key not found.', type: 'not_found_error', param: 'key', code: '404' } });
        const models = asObject(body)['models'];
        state.keys.set(key, { ...current, models: Array.isArray(models) ? models.map(String) : current.models });
        return json(res, 200, { key, models: state.keys.get(key)?.models });
      }

      if (path === '/key/info' && req.method === 'GET') {
        const key = new URL(req.url ?? '/', 'http://fake').searchParams.get('key') ?? '';
        const current = state.keys.get(key);
        if (!current) return json(res, 404, { error: { message: 'Key not found.', type: 'not_found_error', param: 'key', code: '404' } });
        return json(res, 200, { key, info: { models: current.models, metadata: current.metadata } });
      }

      if (path === '/key/delete') {
        const keys = asObject(body)['keys'];
        const list = Array.isArray(keys) ? keys.map(String) : [];
        let removed = 0;
        for (const k of list) if (state.keys.delete(k)) removed += 1;
        if (removed === 0) return json(res, 404, { error: { message: "{'error': 'No keys found'}", type: 'internal_server_error', param: null, code: '404' } });
        return json(res, 200, { deleted_keys: list });
      }

      // Not the management API: a canned completion, so a smoke test can prove a call path end to end and read its usage.
      if (path === '/chat/completions' || path === '/v1/chat/completions') {
        if (options.upstream) return forwardCompletion(options.upstream, req, res, body);
        const model = str(asObject(body)['model']) || 'unknown';
        let content = 'This is the fake proxy.';
        if (options.scenario === 'demo' && !options.completion) {
          const rawMessages = asObject(body)['messages'];
          const messages = (Array.isArray(rawMessages) ? rawMessages : []).map((m) => ({ role: str(asObject(m)['role']), content: str(asObject(m)['content']) }));
          content = demoScenarioCompletion({ model, messages, authorized });
        }
        if (options.completion) {
          const rawMessages = asObject(body)['messages'];
          const messages = (Array.isArray(rawMessages) ? rawMessages : []).map((m) => ({ role: str(asObject(m)['role']), content: str(asObject(m)['content']) }));
          const answer = await options.completion({ model, messages, authorized });
          if (typeof answer !== 'string') return json(res, answer.status, answer.body);
          content = answer;
        }
        // An agent loop (Hermes) asks for server-sent events, like it does of the real proxy: one content chunk, one stop
        // chunk, then [DONE] — the same text the non-streaming answer carries.
        if (asObject(body)['stream'] === true) {
          const created = Math.floor(Date.now() / 1000);
          const chunk = (delta: unknown, finish: string | null): string =>
            `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          const text = `${chunk({ role: 'assistant', content }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
          res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(text) });
          res.end(text);
          return;
        }
        return json(res, 200, {
          id: 'chatcmpl-fake',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        });
      }

      return error(res, 404, `no route ${path}`);
    })().catch((err: unknown) => {
      // A handler bug must not hang the caller: answer 500 and let the client's error path report it.
      if (!res.headersSent) json(res, 500, { error: { message: err instanceof Error ? err.message : 'fake-llm failed' } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake-llm did not bind a TCP port');

  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
