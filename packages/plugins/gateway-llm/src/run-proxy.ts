import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError, type HttpRequest, type HttpResponse, type PluginContext } from '@manythreads/sdk';
import type { LlmProviderServices } from './provider.ts';

// The run-scoped model proxy (SPEC §10.1, PLAN P6-06). An agent that runs on a runner — a machine outside the cluster — cannot resolve the
// cluster's LiteLLM address and must not hold a provider key or the bot's virtual key. So its profile points at this server instead:
//
//   POST /api/llm/runs/<runId>/v1/chat/completions      the chat call, streamed back unchanged (server-sent events pass through)
//   GET  /api/llm/runs/<runId>/v1/models                the models the bot's key may call
//
// The credential is the run's own token — the very token the run's MCP endpoint takes (`Authorization: Bearer <token>`, resolved through the
// run service by its sha256). It is good only while the run is open, only for the run named in the URL, and it dies with the run. The bot's
// virtual key is read here, as the system, and put on the upstream request; it never leaves the server. Aliases, budgets and the DLP hook
// behind the proxy are LiteLLM's and the router's pre-call check, exactly as for a run that talks to the proxy directly.

/** The most request body one chat call may carry (a long context with tool output is large, but not unbounded). */
export const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;

export interface RunProxyDeps {
  /** The run behind a token's sha256, or null for an unknown, revoked, expired or finished one (`ctx.runs.resolve`). */
  resolveRun(tokenHash: Buffer): Promise<{ runId: string; botId: string } | null>;
  /** The bot's live virtual key (system transaction), or null when it has none. */
  botKey(botId: string): Promise<string | null>;
  /** The proxy answered 401 to the bot's key: have the key checked (and registered again if the proxy lost it). Failures are the caller's to swallow. */
  keyRejected?(botId: string): Promise<void>;
  /** The LiteLLM base address (`MANYTHREADS_LITELLM_URL`), '' when none is configured. */
  upstreamBase(): string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** The most one upstream call may take, answer included (default ten minutes; `MANYTHREADS_LLM_PROXY_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Failed authentications per client address per minute before further failures answer 429 (default 60). */
  failuresPerIpPerMinute?: number;
  /** Calls per run per minute (default 1200). Counted per run id, in this process, so one chatty run cannot starve another run behind the same address. */
  perRunPerMinute?: number;
  now?: () => number;
}

/** Keys of a chat body that name a destination or a credential: the server decides those (the bot's key, the gateway's address), never the caller. */
export const CLIENT_CREDENTIAL_KEYS = ['api_base', 'base_url', 'api_key', 'api_version', 'custom_llm_provider', 'extra_headers', 'organization'] as const;

export const DEFAULT_PROXY_TIMEOUT_MS = 10 * 60 * 1000;

const unauthenticated = (): HttpError => new HttpError(401, 'unauthenticated', 'This run endpoint is not valid any more');

/** The bearer token of a request, or null. One header, one scheme; nothing is read from the URL or the body. */
const bearerToken = (headers: Record<string, string | undefined>): string | null => {
  const header = headers['authorization'];
  if (header === undefined) return null;
  return /^Bearer[ \t]+([A-Za-z0-9_-]{1,200})[ \t]*$/.exec(header)?.[1] ?? null;
};

export function runProxyHandlers(deps: RunProxyDeps): {
  chat(req: HttpRequest): Promise<HttpResponse>;
  models(req: HttpRequest): Promise<HttpResponse>;
} {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const limit = deps.perRunPerMinute ?? 1200;
  const now = deps.now ?? Date.now;
  /** Sliding one-minute window per run id. */
  const hits = new Map<string, number[]>();
  // Failed authentications per client address (`req.ip`, which already honours the server's MANYTHREADS_TRUST_PROXY), so a token-guessing or
  // 401 flood is slowed without an honest run behind the same address losing its own bucket.
  const failureLimit = deps.failuresPerIpPerMinute ?? 60;
  const failures = new Map<string, number[]>();
  const failed = (ip: string): HttpError => {
    const at = now();
    const recent = (failures.get(ip) ?? []).filter((t) => at - t < 60_000);
    recent.push(at);
    failures.set(ip, recent);
    if (failures.size > 5000) for (const [key, times] of failures) if (times.every((t) => at - t >= 60_000)) failures.delete(key);
    return recent.length > failureLimit ? new HttpError(429, 'rate_limited', 'Too many failed attempts; slow down', { 'retry-after': '30' }) : unauthenticated();
  };
  const hit = (runId: string): void => {
    const at = now();
    const recent = (hits.get(runId) ?? []).filter((t) => at - t < 60_000);
    if (recent.length >= limit) throw new HttpError(429, 'rate_limited', 'Too many model calls for this run; slow down', { 'retry-after': '5' });
    recent.push(at);
    hits.set(runId, recent);
    if (hits.size > 5000) for (const [id, times] of hits) if (times.every((t) => at - t >= 60_000)) hits.delete(id);
  };

  /** Who may call: the token must open a run and the URL must name that same run. One 401 for every failure, so a probe learns nothing. */
  const authorize = async (req: HttpRequest): Promise<{ key: string; base: string; botId: string }> => {
    const token = bearerToken(req.headers);
    if (token === null) throw failed(req.ip);
    const run = await deps.resolveRun(createHash('sha256').update(token, 'utf8').digest());
    if (!run || run.runId !== req.params['runId']) throw failed(req.ip);
    hit(run.runId);
    const base = deps.upstreamBase();
    if (base === '') throw new HttpError(503, 'internal', 'No model gateway is configured on this server');
    const key = await deps.botKey(run.botId);
    if (key === null) throw new HttpError(503, 'internal', 'This bot has no model key');
    return { key, base, botId: run.botId };
  };

  /** Send `init` upstream and hand the answer back as it arrives (status, content type and a byte stream). */
  const forward = async (url: string, init: RequestInit, botId: string): Promise<HttpResponse> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    let upstream: Response;
    try {
      upstream = await doFetch(url, { ...init, signal: abort.signal });
    } catch {
      clearTimeout(timer);
      throw new HttpError(502, 'internal', 'The model gateway could not be reached');
    }
    if (upstream.status === 401 && deps.keyRejected) {
      // The proxy does not know the key the server holds for this bot (it was replaced or lost its database): have it checked, so the next run works.
      await deps.keyRejected(botId).catch(() => undefined);
    }
    const body = upstream.body ? Readable.fromWeb(upstream.body as never) : Readable.from([]);
    // The caller going away (or the server closing the reply) stops the upstream call too: a dropped agent must not keep a model busy.
    body.once('close', () => {
      clearTimeout(timer);
      abort.abort();
    });
    const headers: Record<string, string> = {};
    const type = upstream.headers.get('content-type');
    if (type) headers['content-type'] = type;
    return { status: upstream.status, body, headers };
  };

  return {
    async chat(req) {
      const { key, base, botId } = await authorize(req);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.stream ?? []) {
        size += chunk.byteLength;
        if (size > MAX_PROXY_BODY_BYTES) throw new HttpError(413, 'validation_failed', 'The request is too large');
        chunks.push(Buffer.from(chunk));
      }
      // The body is the agent's to write, except where it points the call: a client-chosen address or credential would send the bot's key
      // (or the call itself) somewhere the server did not choose. Those keys are dropped; the rest goes through as it was.
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        payload = parsed as Record<string, unknown>;
      } catch {
        throw new HttpError(400, 'validation_failed', 'The request body must be a JSON object');
      }
      for (const name of CLIENT_CREDENTIAL_KEYS) delete payload[name];
      return forward(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      }, botId);
    },
    async models(req) {
      const { key, base, botId } = await authorize(req);
      return forward(`${base}/v1/models`, { method: 'GET', headers: { authorization: `Bearer ${key}` } }, botId);
    },
  };
}

export function registerRunProxy(ctx: PluginContext, botKey: LlmProviderServices['botKey'], keyRejected?: LlmProviderServices['keyRejected']): void {
  const handlers = runProxyHandlers({
    resolveRun: async (hash) => {
      const run = await ctx.runs.resolve(hash);
      return run ? { runId: run.runId, botId: run.botId } : null;
    },
    botKey: (botId) => ctx.db.system((tx) => botKey(tx, botId)),
    ...(keyRejected ? { keyRejected: (botId: string) => ctx.db.system((tx) => keyRejected(tx, botId)) } : {}),
    upstreamBase: () => (process.env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, ''),
    timeoutMs: Number(process.env['MANYTHREADS_LLM_PROXY_TIMEOUT_MS'] ?? '') || DEFAULT_PROXY_TIMEOUT_MS,
  });
  // `public`: the run token is the credential (no session). `rawBody`: the chat body is streamed through, never parsed or size-limited by the
  // framework's JSON parser (a long context is large); the proxy bounds it itself.
  ctx.http.route({
    method: 'POST',
    path: '/api/llm/runs/:runId/v1/chat/completions',
    public: true,
    rawBody: true,
    handler: (req) => handlers.chat(req),
  });
  ctx.http.route({
    method: 'GET',
    path: '/api/llm/runs/:runId/v1/models',
    public: true,
    handler: (req) => handlers.models(req),
  });
}
