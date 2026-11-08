import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { WINDOW_MS, hexAfter, hmacHex, isKind, isObj, oneLine, safeUrl, sameHex, str, withinWindow } from './common.ts';

// The shape any program can send (ours, the same recipe as an outgoing webhook's): `X-Manythreads-Signature: v0=<hex HMAC-SHA256 of "v0:<timestamp>:<raw body>">` with
// `X-Manythreads-Request-Timestamp` (seconds, within five minutes). The body is JSON: `kind` (like `build.failed`), `title`, optionally `url`, `actor` and `id` (the delivery id).

export const generic: ProviderReader = {
  provider: 'generic',
  verify({ headers, rawBody, secret, now }) {
    const stamp = headers['x-manythreads-request-timestamp'];
    const presented = hexAfter(headers['x-manythreads-signature'], 'v0=', 64);
    if (stamp === undefined || presented === null) return { ok: false, reason: 'bad_signature' };
    const expected = hmacHex('sha256', secret, Buffer.concat([Buffer.from(`v0:${stamp}:`, 'utf8'), Buffer.from(rawBody)]));
    if (!sameHex(expected, presented)) return { ok: false, reason: 'bad_signature' };
    return withinWindow(Number(stamp) * 1000, now, WINDOW_MS) ? { ok: true } : { ok: false, reason: 'stale' };
  },
  deliveryKey: (_headers, body) => (isObj(body) ? (str(body['id']) ?? null) : null),
  normalise({ body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const kind = body['kind'] ?? 'event';
    if (typeof kind !== 'string' || !isKind(kind)) return null;
    return { kind, externalId: oneLine(body['id'], 80), url: safeUrl(body['url']), title: oneLine(body['title'], 200), actor: oneLine(body['actor'], 80) };
  },
};
