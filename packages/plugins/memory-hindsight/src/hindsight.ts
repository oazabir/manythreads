// The Hindsight client (SPEC section 12.1, PLAN P5-12). One Hindsight instance runs in the `hindsight` compose service (profile `memory`),
// reachable only from the manythreads server (compose network `memory`), and this module is the only place that speaks to it. It has no idea
// what a team is: a bank is a string handed in by `bank.ts`, which derives it from the run. A client is injectable so tests run against a fake
// transport (or tools/fake-hindsight, a real HTTP server) with no engine at all.
//
// Endpoints (docs.hindsight.vectorize.io; what the real container answers is recorded in docs/plugins/memory-hindsight.md and re-checked by
// test/hindsight.integration.test.ts):
//   PUT    /v1/default/banks/{bank}                  create (or update) a bank
//   POST   /v1/default/banks/{bank}/memories         retain  { items: [{ content, context?, timestamp?, tags?, metadata?, document_id? }], async? }
//   POST   /v1/default/banks/{bank}/memories/recall  recall  { query, types?, budget?, max_tokens?, tags? }  -> { results: [...] }
//   DELETE /v1/default/banks/{bank}/documents/{id}   forget one document
// The bank id travels percent-encoded in the path (`team:engineering` is `team%3Aengineering`).

export interface HindsightResult {
  status: number;
  body: unknown;
}

export interface HindsightTransport {
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, options?: { timeoutMs?: number }): Promise<HindsightResult>;
}

export interface HindsightClientOptions {
  baseUrl: string | null;
  /** Sent as `Authorization: Bearer` when set (the engine's ApiKeyTenantExtension). */
  apiKey: string | null;
  /** Default 15 s for recall and housekeeping. Retain has its own, longer budget (it runs an LLM). */
  timeoutMs?: number;
  retainTimeoutMs?: number;
  transport?: HindsightTransport;
}

export class HindsightError extends Error {
  readonly status: number;
  constructor(path: string, result: HindsightResult) {
    const detail = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    super(`Hindsight ${path} answered ${result.status}: ${scrub(detail ?? '').slice(0, 300)}`);
    this.name = 'HindsightError';
    this.status = result.status;
  }
}

/** The engine echoes request fields in its errors; anything credential-shaped is taken out before a message reaches a log or a model. */
export function scrub(detail: string): string {
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '[redacted]');
}

export interface HindsightFact {
  id: string;
  text: string;
  type: string | null;
  context: string | null;
  tags: string[];
  documentId: string | null;
}

export interface HindsightRetainItem {
  content: string;
  context?: string;
  timestamp?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  documentId?: string;
}

export interface HindsightClient {
  /** False when no URL is configured. */
  readonly enabled: boolean;
  ensureBank(bank: string): Promise<void>;
  retain(bank: string, items: readonly HindsightRetainItem[], options?: { async?: boolean }): Promise<{ items: number; async: boolean }>;
  recall(bank: string, request: { query: string; tags?: readonly string[]; maxTokens?: number }): Promise<HindsightFact[]>;
  deleteDocument(bank: string, documentId: string): Promise<boolean>;
}

const bankPath = (bank: string): string => `/v1/default/banks/${encodeURIComponent(bank)}`;

function fetchTransport(baseUrl: string, apiKey: string | null, timeoutMs: number): HindsightTransport {
  return {
    async request(method, path, body, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? timeoutMs);
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // A non-JSON error page is still an answer.
        }
        return { status: res.status, body: parsed };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One recall result in the engine's shape (`document_id`, snake case) as ours. A malformed entry is dropped, not guessed at. */
function toFact(raw: unknown): HindsightFact | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  const text = str(r['text']);
  if (id === null || text === null) return null;
  return {
    id,
    text,
    type: str(r['type']),
    context: str(r['context']),
    tags: Array.isArray(r['tags']) ? r['tags'].filter((t): t is string => typeof t === 'string') : [],
    documentId: str(r['document_id']),
  };
}

export function createHindsightClient(options: HindsightClientOptions): HindsightClient {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retainTimeoutMs = options.retainTimeoutMs ?? 120_000;
  const transport = options.transport ?? (options.baseUrl ? fetchTransport(options.baseUrl, options.apiKey, timeoutMs) : undefined);
  const known = new Set<string>();

  const send = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, requestOptions?: { timeoutMs?: number }): Promise<HindsightResult> => {
    if (!transport) throw new HindsightError(path, { status: 0, body: 'no Hindsight URL is configured' });
    try {
      return await transport.request(method, path, body, requestOptions);
    } catch (err) {
      // A refused connection or an abort: the engine did not answer. Status 0 = no answer at all.
      throw new HindsightError(path, { status: 0, body: err instanceof Error ? err.message : String(err) });
    }
  };
  const ok = (path: string, result: HindsightResult): HindsightResult => {
    if (result.status < 200 || result.status >= 300) throw new HindsightError(path, result);
    return result;
  };

  const client: HindsightClient = {
    enabled: Boolean(options.baseUrl) || options.transport !== undefined,

    async ensureBank(bank) {
      if (known.has(bank)) return;
      const path = bankPath(bank);
      const res = await send('PUT', path, {});
      // The engine creates a bank on first retain, so a server that has no create call (404/405) is not a failure.
      if (res.status !== 404 && res.status !== 405) ok(path, res);
      known.add(bank);
    },

    async retain(bank, items, retainOptions) {
      await client.ensureBank(bank);
      const path = `${bankPath(bank)}/memories`;
      const body = {
        items: items.map((i) => ({
          content: i.content,
          ...(i.context !== undefined ? { context: i.context } : {}),
          ...(i.timestamp !== undefined ? { timestamp: i.timestamp } : {}),
          ...(i.tags !== undefined && i.tags.length > 0 ? { tags: i.tags } : {}),
          ...(i.metadata !== undefined ? { metadata: i.metadata } : {}),
          ...(i.documentId !== undefined ? { document_id: i.documentId } : {}),
        })),
        async: retainOptions?.async === true,
      };
      const res = ok(path, await send('POST', path, body, { timeoutMs: retainTimeoutMs }));
      const answer = (res.body ?? {}) as { items_count?: unknown; async?: unknown };
      return { items: typeof answer.items_count === 'number' ? answer.items_count : items.length, async: answer.async === true };
    },

    async recall(bank, request) {
      await client.ensureBank(bank);
      const path = `${bankPath(bank)}/memories/recall`;
      const body = {
        query: request.query,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.tags !== undefined && request.tags.length > 0 ? { tags: request.tags } : {}),
      };
      const res = ok(path, await send('POST', path, body));
      const results = (res.body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) throw new HindsightError(path, { status: res.status, body: 'the recall answer has no results array' });
      return results.map(toFact).filter((f): f is HindsightFact => f !== null);
    },

    async deleteDocument(bank, documentId) {
      const path = `${bankPath(bank)}/documents/${encodeURIComponent(documentId)}`;
      const res = await send('DELETE', path);
      if (res.status === 404) return false;
      ok(path, res);
      return true;
    },
  };
  return client;
}

/** A client from `MANYTHREADS_HINDSIGHT_URL` / `MANYTHREADS_HINDSIGHT_API_KEY`; disabled when the URL is unset. Read per call, so a test can set it late. */
export function hindsightFromEnv(env: NodeJS.ProcessEnv = process.env): HindsightClient {
  const baseUrl = (env['MANYTHREADS_HINDSIGHT_URL'] ?? '').trim().replace(/\/+$/, '');
  const apiKey = (env['MANYTHREADS_HINDSIGHT_API_KEY'] ?? '').trim() || null;
  return createHindsightClient({ baseUrl: baseUrl || null, apiKey });
}
