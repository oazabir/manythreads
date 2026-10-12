import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/*
 * fake-llm — a LiteLLM proxy that is not LiteLLM (PLAN P5-08, `tools/fake-llm`).
 *
 * The gateway plugin drives a real LiteLLM proxy over HTTP with a master key, and until now that client was only ever
 * exercised against an injected transport: nothing proved the paths, the bodies or the status codes matched a server.
 * This is that server. It speaks the five management endpoints the client uses (`/model/new`, `/model/update`,
 * `/model/delete`, `/config/update`, `/key/generate`, `/key/delete`), enforces the master key, and keeps its state in
 * memory so a test can read back what the client actually sent.
 *
 * It deliberately reproduces the proxy's awkward habits rather than smoothing them over, because those habits are what
 * the client's retry logic exists for: creating a model that already exists is a 400, not a 409; deleting one that is
 * gone is a 404; minting a key twice is a 400. A fake that answered 200 to everything would pass while the real thing
 * failed.
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

export interface FakeLlmState {
  /** The model list, keyed by `model_name` as the proxy keys it. */
  models: Map<string, Record<string, unknown>>;
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
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/** The proxy's error shape: a message under `error`, which is what the client's duplicate detection reads. */
const error = (res: ServerResponse, status: number, message: string): void => json(res, status, { error: { message } });

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

      state.calls.push({ method: req.method ?? 'GET', path, body, authorized });

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

      const management = path.startsWith('/model/') || path === '/config/update' || path.startsWith('/key/');
      if (management && !authorized) return error(res, 401, 'invalid key');

      if (path === '/model/new') {
        const name = str(asObject(body)['model_name']);
        if (name === '') return error(res, 400, 'model_name is required');
        if (state.models.has(name)) return error(res, 400, `model ${name} already exists`);
        state.models.set(name, asObject(body));
        return json(res, 201, { model_id: `model-${++modelSeq}` });
      }

      if (path === '/model/update') {
        const name = str(asObject(body)['model_name']);
        if (!state.models.has(name)) return error(res, 400, `model ${name} not found`);
        state.models.set(name, asObject(body));
        return json(res, 200, { model_id: name });
      }

      if (path === '/model/delete') {
        const name = str(asObject(body)['model_name']);
        if (!state.models.delete(name)) return error(res, 404, `model ${name} not found`);
        return json(res, 200, { deleted: name });
      }

      if (path === '/config/update') {
        const router = asObject(asObject(body)['router_settings']);
        const fallbacks = router['fallbacks'];
        if (Array.isArray(fallbacks)) state.fallbacks = fallbacks as Array<Record<string, string[]>>;
        return json(res, 200, { ok: true });
      }

      if (path === '/key/generate') {
        const key = str(asObject(body)['key']);
        if (key === '') return error(res, 400, 'key is required');
        if (state.keys.has(key)) return error(res, 400, `key ${key} already exists`);
        const models = asObject(body)['models'];
        const metadata = asObject(asObject(body)['metadata']);
        state.keys.set(key, {
          models: Array.isArray(models) ? models.map(String) : [],
          metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
        });
        return json(res, 201, { key, token: key });
      }

      if (path === '/key/delete') {
        const keys = asObject(body)['keys'];
        const list = Array.isArray(keys) ? keys.map(String) : [];
        let removed = 0;
        for (const k of list) if (state.keys.delete(k)) removed += 1;
        if (removed === 0) return error(res, 404, 'no key deleted');
        return json(res, 200, { deleted_keys: removed });
      }

      // Not the management API: a canned completion, so a smoke test can prove a call path end to end and read its usage.
      if (path === '/chat/completions') {
        const model = str(asObject(body)['model']) || 'unknown';
        return json(res, 200, {
          id: 'chatcmpl-fake',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'This is the fake proxy.' }, finish_reason: 'stop' }],
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
