import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as client from 'openid-client';
import { createRemoteJWKSet, customFetch as joseCustomFetch, jwtVerify, type JWTPayload } from 'jose';
import { assertPublicUrl, guardedFetch, privateIssuersBlocked } from './net-guard.ts';
import type { IdClaims } from './rules.ts';

/** Thrown for anything wrong with the provider's discovery document or endpoints; the message is shown to admins. */
export class DiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DiscoveryError';
  }
}

/** Thrown when the code exchange or the id_token check fails; the message is for logs, never shown to the person. */
export class TokenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenError';
  }
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_S = 10;
const SIGNING_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

const discoveryCache = new Map<string, { at: number; metadata: client.ServerMetadata }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const isHttp = (url: string): boolean => url.startsWith('http://');

/** https everywhere, http only for a loopback host (the dev mock); other http issuers are refused. */
function assertTransport(issuer: string): void {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw new DiscoveryError('The issuer URL is not a valid URL.');
  }
  if (privateIssuersBlocked()) {
    // Production: public https hosts only (no loopback mock, no 10.x / 169.254.x / localhost); see net-guard.ts.
    try {
      assertPublicUrl(issuer);
    } catch (err) {
      throw new DiscoveryError(`The issuer URL is not allowed: ${err instanceof Error ? err.message : 'refused'}`);
    }
    return;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new DiscoveryError('The issuer URL must use https.');
  }
}

/**
 * Fetches and checks the provider's discovery document (cached ten minutes unless `fresh`). The issuer inside the
 * document must equal the URL asked for (openid-client enforces that), and it must offer what the flow needs.
 */
export async function discoverIssuer(issuer: string, clientId: string, options: { fresh?: boolean } = {}): Promise<client.ServerMetadata> {
  assertTransport(issuer);
  const hit = discoveryCache.get(issuer);
  if (!options.fresh && hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.metadata;
  let metadata: client.ServerMetadata;
  try {
    const config = await client.discovery(new URL(issuer), clientId, undefined, undefined, {
      timeout: DISCOVERY_TIMEOUT_S,
      ...(privateIssuersBlocked() ? { [client.customFetch]: guardedFetch } : {}),
      ...(isHttp(issuer) ? { execute: [client.allowInsecureRequests] } : {}),
    });
    metadata = config.serverMetadata();
  } catch (err) {
    throw new DiscoveryError(`Could not read the discovery document at ${issuer}: ${describe(err)}`, { cause: err });
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (!metadata[field]) throw new DiscoveryError(`The discovery document at ${issuer} has no ${field}.`);
  }
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) {
    throw new DiscoveryError('The provider does not support PKCE with S256.');
  }
  if (metadata.response_types_supported && !metadata.response_types_supported.includes('code')) {
    throw new DiscoveryError('The provider does not support the authorization code flow.');
  }
  discoveryCache.set(issuer, { at: Date.now(), metadata });
  return metadata;
}

/** Test hook: forget cached discovery documents and key sets. */
export function resetProtocolCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

const describe = (err: unknown): string => {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`.slice(0, 300);
  }
  return String(err).slice(0, 300);
};

function configurationFor(metadata: client.ServerMetadata, clientId: string, clientSecret: string): client.Configuration {
  const config = new client.Configuration(metadata, clientId, clientSecret);
  if (isHttp(metadata.issuer)) client.allowInsecureRequests(config);
  // The token endpoint comes from the provider's discovery document: it gets the same public-hosts-only treatment.
  if (privateIssuersBlocked()) config[client.customFetch] = guardedFetch as client.CustomFetch;
  return config;
}

export interface FlowStart {
  state: string;
  nonce: string;
  codeVerifier: string;
  url: URL;
}

/** Builds the authorization request: code flow, PKCE S256, a fresh state and nonce. */
export async function startAuthorization(input: {
  metadata: client.ServerMetadata;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Extra authorization parameters (Google `hd`, `prompt`). */
  extra?: Record<string, string>;
}): Promise<FlowStart> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const codeVerifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const config = configurationFor(input.metadata, input.clientId, input.clientSecret);
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    scope: 'openid email profile',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    ...input.extra,
  });
  return { state, nonce, codeVerifier, url };
}

/**
 * Exchanges the code and verifies the id_token. openid-client checks state, `iss`, `aud`, `exp` and the nonce; jose then
 * verifies the signature against the provider's JWKS (openid-client does not for tokens that arrive from the token
 * endpoint) and the nonce is compared once more. Returns the verified claims.
 */
export async function completeAuthorization(input: {
  metadata: client.ServerMetadata;
  clientId: string;
  clientSecret: string;
  /** The callback URL exactly as the provider redirected the browser (with `code` and `state`). */
  callbackUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<IdClaims> {
  const config = configurationFor(input.metadata, input.clientId, input.clientSecret);
  let idToken: string;
  try {
    const tokens = await client.authorizationCodeGrant(config, input.callbackUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.state,
      expectedNonce: input.nonce,
      idTokenExpected: true,
    });
    if (!tokens.id_token) throw new TokenError('The token response has no id_token.');
    idToken = tokens.id_token;
  } catch (err) {
    if (err instanceof TokenError) throw err;
    throw new TokenError(`Code exchange failed: ${describe(err)}`, { cause: err });
  }

  const jwksUri = input.metadata.jwks_uri;
  if (!jwksUri) throw new TokenError('The provider has no jwks_uri.');
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: DISCOVERY_TIMEOUT_S * 1000,
      cooldownDuration: 30_000,
      ...(privateIssuersBlocked() ? { [joseCustomFetch]: guardedFetch as never } : {}),
    });
    jwksCache.set(jwksUri, jwks);
  }
  const advertised = input.metadata.id_token_signing_alg_values_supported?.filter((a) => SIGNING_ALGS.includes(a));
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: input.metadata.issuer,
      audience: input.clientId,
      algorithms: advertised && advertised.length > 0 ? advertised : ['RS256'],
      clockTolerance: 30,
    }));
  } catch (err) {
    throw new TokenError(`The id_token did not verify: ${describe(err)}`, { cause: err });
  }
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, input.nonce)) {
    throw new TokenError('The id_token nonce does not match.');
  }
  return payload as IdClaims;
}

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
