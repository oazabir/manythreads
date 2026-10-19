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
//
// Observed against ghcr.io/vectorize-io/hindsight:0.10.3 (chunks extraction mode; the opt-in test/hindsight.integration.test.ts re-checks them):
//  * every route except GET /health needs `Authorization: Bearer <key>` when the tenant extension is on (401 "Invalid API key", no key = same);
//  * recall (and retain) on a bank that was never created is a **404** "Bank '<id>' not found", so a bank is created first (PUT answers 200 with the
//    bank, and 200 again for a repeat) — and re-created once if the engine lost it (its database was wiped) while this process remembered it;
//  * a recall ALWAYS ranks the bank it was asked about, so it returns that bank's nearest facts even when nothing matches (score near 0): "nothing
//    from another team" means that no fact of the other bank is in the answer, not that the answer is empty;
//  * `document_id` upserts (the old facts of that document go, the new ones come), and DELETE of a document answers 200 with a count, 404
//    "Document not found" for an unknown one, in an existing bank or not; `tags` on recall keep only facts carrying all of them;
//  * `async: true` answers at once with an `operation_id`; a body without `items` is a 422; a bank id with a slash is a routing 404.

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
  constructor(path: string, result: HindsightResult, secrets: readonly (string | null)[] = []) {
    const detail = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    super(`Hindsight ${path} answered ${result.status}: ${scrub(detail ?? '', secrets).slice(0, 300)}`);
    this.name = 'HindsightError';
    this.status = result.status;
  }
}

/**
 * The engine echoes request fields in its errors; anything credential-shaped is taken out before a message reaches a log or a model — and so is
 * the literal API key this client was configured with, whatever shape it has (`secrets`).
 */
export function scrub(detail: string, secrets: readonly (string | null)[] = []): string {
  let text = detail;
  for (const secret of secrets) if (secret && secret.length >= 4) text = text.split(secret).join('[redacted]');
  return text
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
  /** The provenance the platform stamped on the document, as the engine echoes it (the mirror's `concept_path`, `trust_tier`, `stale_after`, …). */
  metadata?: Record<string, string>;
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

/** The most metadata keys a fact's provenance is read into (the platform writes a handful; anything more is not ours). */
const METADATA_MAX_KEYS = 40;

/** The engine's `metadata` map (`{ string: string }` by contract; the provider only ever stamps strings): unknown shapes are left out, not guessed at. */
function metadataOf(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    out[key.slice(0, 64)] = value.slice(0, 500);
    if (Object.keys(out).length >= METADATA_MAX_KEYS) break;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** One recall result in the engine's shape (`document_id`, snake case) as ours. A malformed entry is dropped, not guessed at. */
function toFact(raw: unknown): HindsightFact | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  const text = str(r['text']);
  if (id === null || text === null) return null;
  const metadata = metadataOf(r['metadata']);
  return {
    id,
    text,
    type: str(r['type']),
    context: str(r['context']),
    tags: Array.isArray(r['tags']) ? r['tags'].filter((t): t is string => typeof t === 'string') : [],
    documentId: str(r['document_id']),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function createHindsightClient(options: HindsightClientOptions): HindsightClient {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retainTimeoutMs = options.retainTimeoutMs ?? 120_000;
  const transport = options.transport ?? (options.baseUrl ? fetchTransport(options.baseUrl, options.apiKey, timeoutMs) : undefined);
  const known = new Set<string>();

  const send = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, requestOptions?: { timeoutMs?: number }): Promise<HindsightResult> => {
    if (!transport) throw new HindsightError(path, { status: 0, body: 'no Hindsight URL is configured' }, [options.apiKey]);
    try {
      return await transport.request(method, path, body, requestOptions);
    } catch (err) {
      // A refused connection or an abort: the engine did not answer. Status 0 = no answer at all.
      throw new HindsightError(path, { status: 0, body: err instanceof Error ? err.message : String(err) }, [options.apiKey]);
    }
  };
  const ok = (path: string, result: HindsightResult): HindsightResult => {
    if (result.status < 200 || result.status >= 300) throw new HindsightError(path, result, [options.apiKey]);
    return result;
  };

  /** Runs a call that needs the bank: creates it first, and once more (then gives up) when the engine answers that it has no such bank. */
  const withBank = async (bank: string, call: () => Promise<HindsightResult>): Promise<HindsightResult> => {
    await client.ensureBank(bank);
    const first = await call();
    if (first.status !== 404 || !/bank .*not found/i.test(JSON.stringify(first.body))) return first;
    known.delete(bank);
    await client.ensureBank(bank);
    return call();
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
      const res = ok(path, await withBank(bank, () => send('POST', path, body, { timeoutMs: retainTimeoutMs })));
      const answer = (res.body ?? {}) as { items_count?: unknown; async?: unknown };
      return { items: typeof answer.items_count === 'number' ? answer.items_count : items.length, async: answer.async === true };
    },

    async recall(bank, request) {
      const path = `${bankPath(bank)}/memories/recall`;
      const body = {
        query: request.query,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.tags !== undefined && request.tags.length > 0 ? { tags: request.tags } : {}),
      };
      const res = ok(path, await withBank(bank, () => send('POST', path, body)));
      const results = (res.body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) throw new HindsightError(path, { status: res.status, body: 'the recall answer has no results array' }, [options.apiKey]);
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
