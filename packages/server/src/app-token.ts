import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_TOKEN_TTL_SECONDS, isPathInsideFolder } from '@manythreads/shared';
import { z } from 'zod';

// Per-open tokens for embedded apps (PLAN P4-10; contract in packages/shared/src/surfaces/app-token.ts).
//
// A sandboxed frame without `allow-same-origin` has an opaque origin: the browser does not send the SameSite session cookie with its
// sub-resource requests. So the person's session asks for a token (POST /api/teams/:slug/repo/app-token), puts it in the path of the iframe
// address, and the content route accepts it instead of the cookie. The token is a capability, not a session: it names the person (whose
// read access is checked again on every request, by row level security as always), the team slug and ONE app folder, and expires in
// minutes. It is checked before any route runs (build-server.ts) and only ever authorises a GET or HEAD under the app content route.
//
//   token = "v1." + base64url(claim JSON) + "." + base64url(HMAC-SHA256(secret, "manythreads/app-token/v1\n" + payload))
//
// The secret is derived from MANYTHREADS_KMS_KEY (HKDF, a different key from the one that wraps secrets) so replicas and restarts agree;
// without the master key (a development server) it is random per process, which only means tokens end with the process.

const Claim = z.strictObject({
  /** Actor id of the person the token was issued to. */
  a: z.uuid(),
  /** Workspace of that actor. */
  w: z.uuid(),
  /** Team slug. */
  t: z.string().min(1).max(63),
  /** The app folder (repo path, no leading slash). */
  p: z.string().min(1).max(1024),
  /** Expiry, seconds since the epoch. */
  e: z.number().int().positive(),
});
export type AppTokenClaim = z.infer<typeof Claim>;

export type AppTokenRefusal = 'malformed' | 'signature' | 'expired' | 'team' | 'path';
export type AppTokenCheck = { ok: true; claim: AppTokenClaim } | { ok: false; reason: AppTokenRefusal };

export interface AppTokensOptions {
  /** HMAC key. Default: derived from `MANYTHREADS_KMS_KEY`, else random for this process. */
  secret?: Buffer | string;
  /** Lifetime of a token in seconds (default `APP_TOKEN_TTL_SECONDS`, 300). */
  ttlSeconds?: number;
  now?: () => Date;
}

export interface AppTokens {
  /** A token for `actor` to open `folder` of team `slug` until now + ttl; returns it with its expiry. */
  issue(input: { actorId: string; workspaceId: string; slug: string; folder: string }): { token: string; expiresAt: Date };
  /**
   * Checks signature, expiry and scope: the token's team must be `slug` and `path` must be the token's folder or below it (no `..`, no empty
   * segment). Never throws; the reason is for logs and tests, the client always hears the same thing.
   */
  verify(token: string, scope: { slug: string; path: string }): AppTokenCheck;
}

/** HKDF of the master key into a key of its own, so the key that wraps secrets never signs anything. Random per process without a master key. */
export function appTokenSecretFromEnv(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env['MANYTHREADS_KMS_KEY'];
  if (raw) {
    const master = Buffer.from(raw, 'base64');
    if (master.length === 32) return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'manythreads/app-token/v1', 32));
  }
  return randomBytes(32);
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const PREFIX = 'manythreads/app-token/v1\n';

export function createAppTokens(options: AppTokensOptions = {}): AppTokens {
  const key = typeof options.secret === 'string' ? Buffer.from(options.secret) : (options.secret ?? appTokenSecretFromEnv());
  if (key.length < 16) throw new Error('the app token secret must be at least 16 bytes');
  const ttl = options.ttlSeconds ?? APP_TOKEN_TTL_SECONDS;
  const now = options.now ?? (() => new Date());
  const sign = (payload: string): Buffer => createHmac('sha256', key).update(PREFIX).update(payload).digest();

  return {
    issue({ actorId, workspaceId, slug, folder }) {
      const exp = Math.floor(now().getTime() / 1000) + ttl;
      const payload = b64(JSON.stringify({ a: actorId, w: workspaceId, t: slug, p: folder, e: exp } satisfies AppTokenClaim));
      return { token: `v1.${payload}.${b64(sign(payload))}`, expiresAt: new Date(exp * 1000) };
    },
    verify(token, scope) {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2] || token.length > 2048) return { ok: false, reason: 'malformed' };
      const given = Buffer.from(parts[2], 'base64url');
      const expected = sign(parts[1]);
      // Same length first (timingSafeEqual throws otherwise); the compare itself is constant time.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
      let claim: AppTokenClaim;
      try {
        claim = Claim.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (Math.floor(now().getTime() / 1000) >= claim.e) return { ok: false, reason: 'expired' };
      if (claim.t !== scope.slug) return { ok: false, reason: 'team' };
      if (!isPathInsideFolder(scope.path, claim.p)) return { ok: false, reason: 'path' };
      return { ok: true, claim };
    },
  };
}
