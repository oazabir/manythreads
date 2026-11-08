import type { BridgeProvider } from '@manythreads/shared';

// The one outbound door of the bridges (PLAN Bundle D, decision D27). Every call to a chat service goes through `bridgeCall`:
//   * the host is a constant per service (a Telegram bot token never decides where a call goes), and a service address that arrives inside a payload is dialled only when it matches the
//     service's own list (a Teams service address must be one of Microsoft's hosts);
//   * no redirect is followed (a redirect would be an address nobody listed), ten seconds at most, and no more than 256 KB of the answer is read;
//   * the fake of a test or a stage (`MANYTHREADS_BRIDGE_<SERVICE>_FAKE_BASE`) is honoured outside production only, and only as a plain http(s) origin;
//   * a token is part of the request and never of an error message, a log line or the answer returned to a caller.
// The guard chain (`pre_egress`, destination `bridge`) is run by the caller (outbound.ts) on the text before it gets here.

export const BRIDGE_BASES: Readonly<Record<BridgeProvider, string>> = {
  telegram: 'https://api.telegram.org',
  whatsapp: 'https://graph.facebook.com',
  slack: 'https://slack.com',
  // Teams has no fixed API host: the service address comes with each conversation and must match BRIDGE_HOST_PATTERNS.teams
  teams: 'https://smba.trafficmanager.net',
};

/** The hosts a service address taken from a payload may name, per service. Only Teams hands out an address in its payloads. */
export const BRIDGE_HOST_PATTERNS: Readonly<Partial<Record<BridgeProvider, readonly RegExp[]>>> = {
  teams: [/^[a-z0-9-]+(\.[a-z0-9-]+)*\.botframework\.com$/i, /^smba\.trafficmanager\.net$/i, /^[a-z0-9-]+\.trafficmanager\.net$/i],
};

export const BRIDGE_TIMEOUT_MS = 10_000;
export const BRIDGE_MAX_ANSWER_BYTES = 256 * 1024;

/** Why a send failed, in a form the retry logic reads: `retry` says whether a later try can work; `attention` that the account itself is refused (a wrong or revoked token). */
export class BridgeSendError extends Error {
  readonly retry: boolean;
  readonly attention: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(message: string, opts: { retry: boolean; attention?: boolean; status?: number | null; retryAfterMs?: number | null }) {
    super(message);
    this.name = 'BridgeSendError';
    this.retry = opts.retry;
    this.attention = opts.attention ?? false;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** The fake base of a service, or null: never in production, only `http(s)://host[:port]`. */
export function fakeBase(provider: BridgeProvider, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['NODE_ENV'] === 'production') return null;
  const raw = env[`MANYTHREADS_BRIDGE_${provider.toUpperCase()}_FAKE_BASE`]?.trim().replace(/\/+$/, '');
  return raw && /^https?:\/\/[^\s/]+$/.test(raw) ? raw : null;
}

/** The origin a call to this service goes to. A `serviceUrl` (Teams) is used only when it is https and its host is on the service's list; null when it is not allowed. */
export function originFor(provider: BridgeProvider, serviceUrl?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const fake = fakeBase(provider, env);
  if (serviceUrl === undefined || serviceUrl === null) return fake ?? BRIDGE_BASES[provider];
  if (fake !== null) {
    // against the fake, an address is honoured only when it is the fake itself
    try {
      return new URL(serviceUrl).origin === new URL(fake).origin ? fake : null;
    } catch {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return null;
  }
  const patterns = BRIDGE_HOST_PATTERNS[provider];
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443') || !patterns) return null;
  return patterns.some((p) => p.test(url.hostname)) ? url.origin : null;
}

export interface BridgeCallInput {
  provider: BridgeProvider;
  /** Path (and query) on the service's origin, starting with `/`. */
  path: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Used instead of the constant base when the service handed one out (Teams) and it passes `originFor`. */
  serviceUrl?: string | null;
}

export interface BridgeCallResult {
  status: number;
  /** The answer, at most 256 KB. */
  text: string;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Sends one request. Throws `BridgeSendError` for an address that is not allowed, a network failure or a timeout; a service's own refusal comes back as a status for the adapter to read. */
export async function bridgeCall(input: BridgeCallInput, env: NodeJS.ProcessEnv = process.env): Promise<BridgeCallResult> {
  if (!input.path.startsWith('/') || input.path.startsWith('//')) throw new BridgeSendError('The chat app address is not valid', { retry: false });
  const origin = originFor(input.provider, input.serviceUrl ?? null, env);
  if (origin === null) throw new BridgeSendError('That chat app address is not on the list of addresses manythreads talks to', { retry: false });
  try {
    const res = await fetch(`${origin}${input.path}`, {
      method: input.method ?? 'POST',
      headers: { ...(input.json !== undefined ? { 'content-type': 'application/json' } : {}), accept: 'application/json', ...input.headers },
      ...(input.json !== undefined ? { body: JSON.stringify(input.json) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    return { status: res.status, text: await readCapped(res, BRIDGE_MAX_ANSWER_BYTES) };
  } catch (err) {
    if (err instanceof BridgeSendError) throw err;
    // never the cause: a fetch error can carry the address, which for some services holds a token
    throw new BridgeSendError(err instanceof Error && err.name === 'TimeoutError' ? 'The chat app did not answer in time' : 'The chat app could not be reached', { retry: true });
  }
}

/** Reads a JSON answer, or null when it is not JSON. */
export function readJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The error for a service's answer that is not a success: 429 and 5xx can be tried again; 401 and 403 from the token's own check mean the account needs attention; the rest are final. */
export function failureOf(status: number, retryAfterSeconds: number | null, what: string): BridgeSendError {
  const retry = status === 429 || status >= 500;
  return new BridgeSendError(`${what} (${String(status)})`, {
    retry,
    attention: status === 401,
    status,
    retryAfterMs: status === 429 && retryAfterSeconds !== null ? Math.min(Math.max(retryAfterSeconds, 1), 300) * 1000 : null,
  });
}
