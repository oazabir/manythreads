import { createHmac, timingSafeEqual } from 'node:crypto';

// The signed link at the foot of an email digest (PLAN P14-09). The token names one person and proves the server made it:
//
//   token = "v1." + <person id> + "." + base64url(HMAC-SHA256(key, "manythreads/digest-unsubscribe/v1\n" + person id))
//
// The key is that person's own random `unsubscribe_key` (migration 0005), made once and never changed, so a link in an old mail never stops working and
// no deployment secret has to stay the same for it to work. The token carries no time: it cannot expire silently. It is good for one thing, which the
// route enforces: turning the digest off for the person it names. Nothing else is in the link.

const LABEL = 'manythreads/digest-unsubscribe/v1\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

const macOf = (key: string, personId: string): Buffer => createHmac('sha256', key).update(`${LABEL}${personId}`).digest();

/** The token for a person, from their key. */
export function signDigestToken(personId: string, key: string): string {
  return `v1.${personId}.${macOf(key, personId).toString('base64url')}`;
}

/** The person and signature a token claims, or null when it is not shaped like one (nothing is checked against a key yet). */
export function parseDigestToken(token: string): { personId: string; mac: string } | null {
  if (token.length > 100) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, personId, mac] = parts as [string, string, string];
  return UUID.test(personId) && MAC.test(mac) ? { personId, mac } : null;
}

/** Does `mac` belong to this person under this key? Compared in constant time; any malformed value is a plain false. */
export function digestMacMatches(key: string, personId: string, mac: string): boolean {
  const given = Buffer.from(mac, 'base64url');
  const expected = macOf(key, personId);
  // The last character of 32 bytes in base64 carries two spare bits, so a few different strings decode to the same bytes: only the one the server wrote counts.
  return given.length === expected.length && given.toString('base64url') === mac && timingSafeEqual(given, expected);
}
