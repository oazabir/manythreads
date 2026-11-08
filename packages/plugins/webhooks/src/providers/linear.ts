import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { LINEAR_WINDOW_MS, at, hexAfter, hmacHex, isObj, num, oneLine, safeUrl, sameHex, str, withinWindow } from './common.ts';

// Linear (developers.linear.app "Webhooks"): `Linear-Signature` is the hex HMAC-SHA256 of the raw body; the body's `webhookTimestamp` (milliseconds) must be within one minute of
// now. `Linear-Delivery` is the delivery id. The timestamp is inside the signed body, so it cannot be changed without breaking the signature.

const ACTIONS: Record<string, string> = { create: 'created', update: 'updated', remove: 'deleted' };

export const linear: ProviderReader = {
  provider: 'linear',
  verify({ headers, rawBody, secret, now }) {
    const presented = hexAfter(headers['linear-signature'], '', 64);
    if (presented === null || !sameHex(hmacHex('sha256', secret, rawBody), presented)) return { ok: false, reason: 'bad_signature' };
    let stamp: number | undefined;
    try {
      stamp = num(at(JSON.parse(Buffer.from(rawBody).toString('utf8')), 'webhookTimestamp'));
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    return stamp !== undefined && withinWindow(stamp, now, LINEAR_WINDOW_MS) ? { ok: true } : { ok: false, reason: 'stale' };
  },
  deliveryKey: (headers) => str(headers['linear-delivery']) ?? null,
  normalise({ body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const type = str(body['type']);
    const action = ACTIONS[str(body['action']) ?? ''];
    if (action === undefined) return null;
    const data = body['data'];
    const actor = oneLine(at(body, 'actor', 'name'), 80);
    if (type === 'Issue') {
      return { kind: `issue.${action}`, externalId: oneLine(at(data, 'identifier') ?? at(data, 'id'), 80), url: safeUrl(body['url']), title: oneLine(at(data, 'title'), 200), actor };
    }
    if (type === 'Comment') {
      return { kind: `comment.${action}`, externalId: oneLine(at(data, 'id'), 80), url: safeUrl(body['url']), title: oneLine(at(data, 'body'), 200), actor };
    }
    return null;
  },
};
