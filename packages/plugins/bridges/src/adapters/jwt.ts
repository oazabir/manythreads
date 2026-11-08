import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

// RS256 tokens checked with `node:crypto` only (PLAN Bundle D, P16-09, decision D30): the Bot Framework signs the call it makes to a bot with a JWT, and this file is the whole check. It is written for hostile
// input: every size is capped before anything is decoded, nothing is matched with a pattern that can backtrack, and the only algorithm is RS256 (a token that asks for `none` or an HMAC is refused
// before its signature is looked at, which is the classic key-confusion attack). No token, key or claim is ever put in an error: a failure is one of the short reasons below.

/** The longest token read: a real one is about 1.5 KB. */
export const JWT_MAX_BYTES = 8192;
/** The smallest and largest RSA modulus accepted, in base64url characters (2048 and 8192 bits). */
const MODULUS_CHARS = { min: 340, max: 1368 } as const;

export type JwtFailure = 'malformed' | 'algorithm' | 'kid' | 'signature' | 'issuer' | 'audience' | 'expired' | 'not_yet' | 'claims';

/** A public key as the Bot Framework publishes it (RFC 7517), with the channels it is endorsed for. */
export interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  use?: string;
  alg?: string;
  endorsements?: string[];
}

export interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  [claim: string]: unknown;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: JwtClaims;
  /** `<header>.<payload>` as sent: what the signature covers. */
  signingInput: string;
  signature: Buffer;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function jsonPart(part: string): Record<string, unknown> | null {
  if (part.length === 0 || part.length > 4096 || !BASE64URL.test(part)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads the three parts of a compact token. Nothing is trusted yet: this only splits and decodes. Null when the token is not three base64url parts holding JSON, JSON, bytes. */
export function decodeJwt(token: string): DecodedJwt | null {
  if (token.length === 0 || token.length > JWT_MAX_BYTES) return null;
  const first = token.indexOf('.');
  const second = first < 0 ? -1 : token.indexOf('.', first + 1);
  if (first <= 0 || second <= first + 1 || token.indexOf('.', second + 1) >= 0) return null;
  const header = jsonPart(token.slice(0, first));
  const claims = jsonPart(token.slice(first + 1, second));
  const sig = token.slice(second + 1);
  if (!header || !claims || sig.length === 0 || sig.length > 1400 || !BASE64URL.test(sig)) return null;
  return { header, claims, signingInput: token.slice(0, second), signature: Buffer.from(sig, 'base64url') };
}

/** The `kid` a token names, to look its key up before the check; null when it names none. */
export function kidOf(token: string): string | null {
  const first = token.indexOf('.');
  if (first <= 0 || token.length > JWT_MAX_BYTES) return null;
  const header = jsonPart(token.slice(0, first));
  const kid = header?.['kid'];
  return typeof kid === 'string' && kid.length > 0 && kid.length <= 200 ? kid : null;
}

const asKey = new WeakMap<Jwk, KeyObject | null>();

/** The public key of a JWK, or null when it is not a usable RSA signing key (wrong type, not for signing, too small or too large). */
export function publicKeyOf(jwk: Jwk): KeyObject | null {
  const cached = asKey.get(jwk);
  if (cached !== undefined) return cached;
  let key: KeyObject | null = null;
  if (
    jwk.kty === 'RSA' &&
    (jwk.use === undefined || jwk.use === 'sig') &&
    (jwk.alg === undefined || jwk.alg === 'RS256') &&
    typeof jwk.n === 'string' &&
    jwk.n.length >= MODULUS_CHARS.min &&
    jwk.n.length <= MODULUS_CHARS.max &&
    BASE64URL.test(jwk.n) &&
    typeof jwk.e === 'string' &&
    jwk.e.length >= 1 &&
    jwk.e.length <= 8 &&
    BASE64URL.test(jwk.e)
  ) {
    try {
      key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    } catch {
      key = null;
    }
  }
  asKey.set(jwk, key);
  return key;
}

export interface VerifyOptions {
  /** The key a token's `kid` names, or undefined. */
  keyFor(kid: string): Jwk | undefined;
  /** The one issuer accepted. */
  issuer: string;
  /** The audience accepted (the bot's app id); compared as the same text, ignoring case. */
  audience: string;
  /** The checker's clock, milliseconds. */
  now: number;
  /** How far the clocks may differ, milliseconds. */
  skewMs: number;
}

export type VerifyResult = { ok: true; claims: JwtClaims; key: Jwk } | { ok: false; reason: JwtFailure };

const fail = (reason: JwtFailure): VerifyResult => ({ ok: false, reason });

/**
 * Is this token one the issuer signed for this audience, and is it live? In this order, so a cheap refusal comes first and the signature is checked once everything that can be read is sane:
 * shape, algorithm exactly RS256 (and no `crit` extension), a known key id, the signature, then issuer, audience, expiry (required) and not-before (when present).
 */
export function verifyJwt(token: string, opts: VerifyOptions): VerifyResult {
  const t = decodeJwt(token);
  if (!t) return fail('malformed');
  if (t.header['alg'] !== 'RS256' || t.header['crit'] !== undefined) return fail('algorithm');
  const kid = t.header['kid'];
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 200) return fail('kid');
  const jwk = opts.keyFor(kid);
  const key = jwk ? publicKeyOf(jwk) : null;
  if (!jwk || !key) return fail('kid');
  let good = false;
  try {
    good = verifySignature('RSA-SHA256', Buffer.from(t.signingInput, 'ascii'), key, t.signature);
  } catch {
    good = false;
  }
  if (!good) return fail('signature');
  const c = t.claims;
  if (typeof c.iss !== 'string' || c.iss !== opts.issuer) return fail('issuer');
  const audiences = typeof c.aud === 'string' ? [c.aud] : Array.isArray(c.aud) ? c.aud.slice(0, 20) : [];
  const want = opts.audience.toLowerCase();
  if (opts.audience.length === 0 || !audiences.some((a) => typeof a === 'string' && a.toLowerCase() === want)) return fail('audience');
  const exp = c.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return fail('claims');
  if (opts.now > exp * 1000 + opts.skewMs) return fail('expired');
  const nbf = c.nbf;
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) return fail('claims');
    if (opts.now < nbf * 1000 - opts.skewMs) return fail('not_yet');
  }
  return { ok: true, claims: c, key: jwk };
}

/** Reads a published key set (`{keys: [...]}`) into the keys that are usable. A key that is not an object with the needed text fields is left out. */
export function parseKeySet(doc: unknown): Jwk[] {
  const keys = rec(doc)['keys'];
  if (!Array.isArray(keys)) return [];
  const out: Jwk[] = [];
  for (const raw of keys.slice(0, 50)) {
    const k = rec(raw);
    if (typeof k['kty'] !== 'string' || typeof k['kid'] !== 'string' || typeof k['n'] !== 'string' || typeof k['e'] !== 'string' || k['kid'].length === 0 || k['kid'].length > 200) continue;
    const endorsements = Array.isArray(k['endorsements']) ? k['endorsements'].filter((e): e is string => typeof e === 'string').slice(0, 50) : undefined;
    out.push({
      kty: k['kty'],
      kid: k['kid'],
      n: k['n'],
      e: k['e'],
      ...(typeof k['use'] === 'string' ? { use: k['use'] } : {}),
      ...(typeof k['alg'] === 'string' ? { alg: k['alg'] } : {}),
      ...(endorsements ? { endorsements } : {}),
    });
  }
  return out;
}

export interface KeyCacheOptions {
  /** Fetches the current key set; throws when it cannot. */
  fetch(): Promise<Jwk[]>;
  /** How long a fetched set is trusted. */
  ttlMs: number;
  /** An unknown key id asks for a fresh set at most this often (a flood of forged ids cannot make the server call out for each). */
  missRefreshMs: number;
  /** A set that cannot be refreshed is still used for this long past its ttl. */
  staleMs: number;
}

export interface KeyCache {
  /** The key for an id, fetching when the set is old or the id is new (rate limited). */
  get(kid: string, now: number): Promise<Jwk | undefined>;
  /** The key for an id from what is held, without fetching. */
  peek(kid: string, now: number): Jwk | undefined;
  clear(): void;
}

/** A cache of one issuer's published keys. Calls that arrive while a fetch is under way share it. */
export function createKeyCache(opts: KeyCacheOptions): KeyCache {
  let keys = new Map<string, Jwk>();
  let fetchedAt = 0;
  let triedAt = 0;
  let inflight: Promise<void> | null = null;

  const refresh = (now: number): Promise<void> => {
    if (inflight) return inflight;
    triedAt = now;
    inflight = opts
      .fetch()
      .then((list) => {
        if (list.length === 0) return;
        keys = new Map(list.map((k) => [k.kid, k]));
        fetchedAt = now;
      })
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const held = (kid: string, now: number): Jwk | undefined => {
    const found = keys.get(kid);
    return found !== undefined && fetchedAt !== 0 && now - fetchedAt <= opts.ttlMs + opts.staleMs ? found : undefined;
  };

  return {
    peek: held,
    async get(kid, now) {
      const old = fetchedAt === 0 || now - fetchedAt > opts.ttlMs;
      if (old && (triedAt === 0 || now - triedAt >= opts.missRefreshMs)) await refresh(now);
      if (held(kid, now) === undefined && !old && now - triedAt >= opts.missRefreshMs) {
        // a key id nobody has seen: the issuer may have rotated, so look once (not more often than the rate)
        await refresh(now);
      }
      return held(kid, now);
    },
    clear() {
      keys = new Map();
      fetchedAt = 0;
      triedAt = 0;
      inflight = null;
    },
  };
}
