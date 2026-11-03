import { createHash, randomBytes } from 'node:crypto';
import type { Endpoints, OAuthProviderDef } from './providers.ts';

// The OAuth authorization-code flow with PKCE, written once for every provider (PLAN P8-02, and the "one helper" question of PLAN Phase 16 §0). It builds the consent
// address, trades the code for tokens, renews an access token with the refresh token, and takes a token back. It reads only an `OAuthProviderDef` and the provider's
// `Endpoints`; it knows nothing of Google, Microsoft or Notion by name, and nothing of the database (store.ts does that).
//
//   * The `state` is 256 random bits, kept as a hash on our side and single use; it ties the callback to the flow the signed-in person started.
//   * PKCE (RFC 7636, method S256): a random verifier is kept on our side, only its hash goes to the provider's consent page, and the verifier is sent with the code.
//     Whoever steals the code from the redirect cannot use it. A provider with no PKCE (Notion) gets the state only, and its app secret on the token call.
//   * An answer is read to 1 MiB at most, in 10 seconds at most, with no redirect followed. A refusal is described by the provider's short `error` code only; the
//     body of an answer, a token or a client secret never goes into an error message, a log line or an event.

/** Why a call to the provider's token address failed, as far as a caller must tell: the sign-in is dead (`invalid_grant`), the provider is down (`unavailable`), or it refused for another reason. */
export type OAuthFailure = 'invalid_grant' | 'unavailable' | 'rejected';

export class OAuthError extends Error {
  readonly failure: OAuthFailure;
  constructor(failure: OAuthFailure, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.failure = failure;
  }
}

/** What a provider handed back for a code or a refresh token. */
export interface TokenSet {
  accessToken: string;
  /** Null when the provider sent none (a refresh that keeps the old one; Notion never sends one). */
  refreshToken: string | null;
  /** Seconds until the access token stops working; null when the provider says it does not. */
  expiresInSec: number | null;
  /** The scopes the provider says were granted, or null when it did not say. */
  scopes: string[] | null;
  /** Provider-specific extras for the account label (Notion's workspace name and owner), already reduced to short strings. */
  accountHint: string | null;
}

const TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 1024 * 1024;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;

/** The real fetch, with the redirect set to manual so a hostile address cannot bounce a token somewhere else. */
export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Reads an answer to its end or to the size cap, whichever comes first, and parses it as JSON (null when it is not JSON). */
export async function readJson(res: Response): Promise<unknown> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new OAuthError('rejected', 'The provider’s answer was too large.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

export interface FlowSecrets {
  /** Goes to the provider and comes back; we keep only its hash. */
  state: string;
  /** Kept on our side until the callback; null for a provider with no PKCE. */
  verifier: string | null;
  /** Sent to the provider with the consent address; null for a provider with no PKCE. */
  challenge: string | null;
}

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** A fresh state, and for a provider with PKCE a fresh verifier (43 to 128 characters) and its S256 challenge. */
export function newFlowSecrets(provider: Pick<OAuthProviderDef, 'pkce'>): FlowSecrets {
  const state = base64url(randomBytes(32));
  if (!provider.pkce) return { state, verifier: null, challenge: null };
  const verifier = base64url(randomBytes(48));
  return { state, verifier, challenge: base64url(sha256(verifier)) };
}

/** The consent address: where the browser is sent so the person can say yes at the provider. */
export function authorizationUrl(
  provider: OAuthProviderDef,
  endpoints: Pick<Endpoints, 'authorizeUrl'>,
  input: { clientId: string; redirectUri: string; scopes: readonly string[]; state: string; challenge: string | null },
): string {
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  if (provider.scopeParam && input.scopes.length > 0) url.searchParams.set('scope', input.scopes.join(provider.scopeSeparator ?? ' '));
  if (input.challenge !== null) {
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(provider.authorizeExtra)) url.searchParams.set(k, v);
  return url.toString();
}

interface TokenCall {
  provider: OAuthProviderDef;
  endpoints: Pick<Endpoints, 'tokenUrl'>;
  app: { clientId: string; clientSecret: string };
  fetchImpl?: FetchLike | undefined;
}

/** One POST to the provider's token address (the code exchange and the refresh are the same call with different fields). */
async function tokenRequest(call: TokenCall, fields: Record<string, string>): Promise<TokenSet> {
  const { provider, app } = call;
  const headers: Record<string, string> = { accept: 'application/json' };
  const payload: Record<string, string> = { ...fields };
  if (provider.clientAuth === 'basic') headers['authorization'] = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`;
  else {
    payload['client_id'] = app.clientId;
    payload['client_secret'] = app.clientSecret;
  }
  let body: string;
  if (provider.tokenBody === 'json') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  }
  let res: Response;
  try {
    res = await (call.fetchImpl ?? defaultFetch)(call.endpoints.tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  } catch {
    throw new OAuthError('unavailable', `${provider.label} did not answer.`);
  }
  const doc = (await readJson(res).catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof doc?.['error'] === 'string' && /^[a-z_]{1,64}$/.test(doc['error']) ? doc['error'] : null;
    if (res.status >= 500 || res.status === 429) throw new OAuthError('unavailable', `${provider.label} is not available right now.`);
    if (code === 'invalid_grant') throw new OAuthError('invalid_grant', `${provider.label} no longer honours this sign-in.`);
    throw new OAuthError('rejected', `${provider.label} refused the request${code ? ` (${code})` : ''}.`);
  }
  if (!doc || typeof doc['access_token'] !== 'string' || doc['access_token'] === '') throw new OAuthError('rejected', `${provider.label} answered without an access token.`);
  const expires = typeof doc['expires_in'] === 'number' && Number.isFinite(doc['expires_in']) && doc['expires_in'] > 0 ? Math.floor(doc['expires_in']) : null;
  // a string with spaces (most providers) or commas (Linear), or a list of strings (Linear's token answer)
  const rawScope = doc['scope'];
  const scopeWords = typeof rawScope === 'string' ? rawScope.trim().split(/[\s,]+/) : Array.isArray(rawScope) ? rawScope.filter((x): x is string => typeof x === 'string') : [];
  const scope = scopeWords.filter((w) => w !== '').slice(0, 64);
  const workspace = typeof doc['workspace_name'] === 'string' ? doc['workspace_name'].slice(0, 120) : null;
  return {
    accessToken: doc['access_token'],
    refreshToken: typeof doc['refresh_token'] === 'string' && doc['refresh_token'] !== '' ? doc['refresh_token'] : null,
    expiresInSec: expires,
    scopes: scope.length > 0 ? scope : null,
    accountHint: workspace,
  };
}

/** Trades the one-time code the provider put in the redirect for tokens. `verifier` is the PKCE proof kept at the start (null for a provider without PKCE). */
export function exchangeCode(call: TokenCall, input: { code: string; redirectUri: string; verifier: string | null }): Promise<TokenSet> {
  return tokenRequest(call, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    ...(input.verifier !== null ? { code_verifier: input.verifier } : {}),
  });
}

/** Renews an access token. A provider may rotate the refresh token (the answer then carries a new one, and the old one stops working). */
export function refreshAccess(call: TokenCall, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(call, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Tells the provider to forget a token. Best effort: a failure is the caller's to ignore (the connection is deleted on our side either way). */
export async function revokeToken(call: TokenCall & { endpoints: Pick<Endpoints, 'tokenUrl' | 'revokeUrl'> }, token: string): Promise<boolean> {
  const url = call.endpoints.revokeUrl;
  if (!url) return false;
  const { provider, app } = call;
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string;
  if (provider.clientAuth === 'basic') {
    headers['authorization'] = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`;
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ token });
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ token }).toString();
  }
  try {
    const res = await (call.fetchImpl ?? defaultFetch)(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
