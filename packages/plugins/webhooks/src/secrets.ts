import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_SECRET_PREFIX, WEBHOOK_SIGNING_PREFIX } from '@manythreads/shared';

// The credentials of a webhook. The secret part of its address is 256 random bits; only its sha256 is stored, so a database copy cannot call the
// webhook. Comparing is done on the two hashes in constant time. The optional signing secret is the one a sender such as GitHub signs its calls with:
// it must be kept readable (a signature is recomputed from it), so it is sealed with the platform's secret service instead of hashed.

export const newWebhookSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
export const newSigningSecret = (): string => `${WEBHOOK_SIGNING_PREFIX}${randomBytes(32).toString('base64url')}`;

/** What the database keeps: sha256 of the secret's utf8 bytes. */
export const hashWebhookSecret = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();

/** Whether `secret` is the one `storedHash` was made from. Constant time in the hash length; a missing hash compares against a dummy so the time does not tell. */
export function secretMatches(secret: string, storedHash: Buffer | null): boolean {
  const presented = hashWebhookSecret(secret);
  const expected = storedHash !== null && storedHash.length === presented.length ? storedHash : Buffer.alloc(presented.length, 1);
  const equal = timingSafeEqual(presented, expected);
  return equal && storedHash !== null && storedHash.length === presented.length;
}

/** `sha256=<hex>`, the value GitHub puts in `X-Hub-Signature-256` for a body signed with `secret`. */
export const githubSignature = (secret: string, body: Uint8Array): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** Whether a presented `X-Hub-Signature-256` is the signature of `body` under `secret`. Constant time; a malformed value is just false. */
export function signatureMatches(secret: string, body: Uint8Array, presented: string | undefined): boolean {
  if (presented === undefined || !/^sha256=[0-9a-f]{64}$/i.test(presented)) return false;
  const want = Buffer.from(githubSignature(secret, body), 'utf8');
  const got = Buffer.from(presented.toLowerCase(), 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Constant-time equality of two strings (GitLab sends its secret as a plain `X-Gitlab-Token` header). */
export function tokenMatches(secret: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = createHash('sha256').update(secret, 'utf8').digest();
  const b = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether a call is signed with `secret`: GitHub's `X-Hub-Signature-256` (an HMAC of the raw body) or GitLab's `X-Gitlab-Token` (the secret itself).
 * Either one is enough; with neither, or a wrong one, the call is not signed.
 */
export function callIsSigned(secret: string, body: Uint8Array, headers: Readonly<Record<string, string | undefined>>): boolean {
  if (headers['x-hub-signature-256'] !== undefined && signatureMatches(secret, body, headers['x-hub-signature-256'])) return true;
  return headers['x-gitlab-token'] !== undefined && tokenMatches(secret, headers['x-gitlab-token']);
}
