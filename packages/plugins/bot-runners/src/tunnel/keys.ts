import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRIDGE_KEY_PATTERN, ENROL_CODE_PATTERN } from '@manythreads/shared';

// The bridge key and the enrolment code: made here, shown once, kept only as a SHA-256 hash (docs/plans/agents-anywhere.md §5.5). Both are high-entropy random strings, so a
// plain hash is the right tool (nothing to stretch), and the hash is what the database index looks up.

export const newBridgeKey = (): string => `mtb_${randomBytes(32).toString('hex')}`;
export const newEnrolCode = (): string => `mte_${randomBytes(20).toString('hex')}`;

export const hashSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

/** The shape check comes before any lookup, so a malformed string never reaches the database. */
export const looksLikeBridgeKey = (s: string): boolean => BRIDGE_KEY_PATTERN.test(s);
export const looksLikeEnrolCode = (s: string): boolean => ENROL_CODE_PATTERN.test(s);

/** `Authorization: Bearer mtb_...` to the key, or null. */
export function bearerBridgeKey(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+(mtb_[0-9a-f]{64})[ \t]*$/.exec(header ?? '');
  return m ? m[1]! : null;
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
