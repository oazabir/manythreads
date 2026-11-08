import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { at, hexAfter, hmacHex, isObj, kindFrom, oneLine, sameHex, str, toMs } from './common.ts';

// Asana (developers.asana.com "Webhooks"): creating a webhook starts a handshake (the request carries `X-Hook-Secret`, which must be sent back in the answer's header and kept). After it
// every call carries `X-Hook-Signature`, the hex HMAC-SHA256 of the raw body under that secret. The handshake itself is answered by the door, not here. A call with no events is a
// heartbeat and is ignored. Asana sends no delivery id: the door uses a hash of the body.

const ACTIONS: Record<string, string> = { added: 'created', changed: 'changed', removed: 'removed', deleted: 'deleted', undeleted: 'restored' };

export const asana: ProviderReader = {
  provider: 'asana',
  verify({ headers, rawBody, secret }) {
    const presented = hexAfter(headers['x-hook-signature'], '', 64);
    if (presented === null) return { ok: false, reason: 'bad_signature' };
    return sameHex(hmacHex('sha256', secret, rawBody), presented) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },
  deliveryKey: () => null,
  eventTime: (_headers, body) => toMs(at(Array.isArray(at(body, 'events')) ? (at(body, 'events') as unknown[])[0] : undefined, 'created_at')),
  normalise({ body }): NormalisedProviderEvent | null {
    const events = at(body, 'events');
    const first: unknown = Array.isArray(events) ? events[0] : undefined;
    if (!isObj(first)) return null;
    const action = ACTIONS[str(first['action']) ?? ''];
    const type = kindFrom(at(first, 'resource', 'resource_type'));
    if (action === undefined || type === null) return null;
    const gid = oneLine(at(first, 'resource', 'gid'), 40);
    const more = Array.isArray(events) && events.length > 1 ? ` (and ${events.length - 1} more in this delivery)` : '';
    return {
      kind: `${type}.${action}`,
      externalId: gid,
      url: type === 'task' && gid !== '' ? `https://app.asana.com/0/0/${encodeURIComponent(gid)}` : null,
      title: `${oneLine(at(first, 'resource', 'name') ?? `${type} ${gid}`, 180)}${more}`,
      actor: oneLine(at(first, 'user', 'name') ?? at(first, 'user', 'gid'), 80),
    };
  },
};
