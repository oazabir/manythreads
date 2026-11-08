import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { WINDOW_MS, at, hmacBase64, isObj, num, oneLine, sameSecret, str, withinWindow } from './common.ts';

// HubSpot webhooks (developers.hubspot.com "Validating requests", signature v3): `X-HubSpot-Signature-v3` is the base64 HMAC-SHA256, under the app's client secret, of the method,
// the full address, the raw body and `X-HubSpot-Request-Timestamp` (milliseconds, within five minutes) joined as one string. The body is a list of events; the first one's `eventId` is
// the delivery id and the whole list is kept in the stored payload.

const OBJECT_TYPES: Record<string, string> = { contact: '0-1', company: '0-2', deal: '0-3', ticket: '0-5' };
const ACTIONS: Record<string, string> = { creation: 'created', deletion: 'deleted', propertychange: 'updated', merge: 'merged', restore: 'restored' };

export const hubspot: ProviderReader = {
  provider: 'hubspot',
  verify({ headers, rawBody, secret, now, method, uri }) {
    const stamp = headers['x-hubspot-request-timestamp'];
    const presented = headers['x-hubspot-signature-v3'];
    if (stamp === undefined || presented === undefined) return { ok: false, reason: 'bad_signature' };
    const expected = hmacBase64(secret, Buffer.concat([Buffer.from(method.toUpperCase() + uri, 'utf8'), Buffer.from(rawBody), Buffer.from(stamp, 'utf8')]));
    if (!sameSecret(expected, presented)) return { ok: false, reason: 'bad_signature' };
    return withinWindow(Number(stamp), now, WINDOW_MS) ? { ok: true } : { ok: false, reason: 'stale' };
  },
  deliveryKey: (_headers, body) => {
    const first = Array.isArray(body) ? body[0] : undefined;
    const id = at(first, 'eventId');
    return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
  },
  normalise({ body }): NormalisedProviderEvent | null {
    const first: unknown = Array.isArray(body) ? body[0] : undefined;
    if (!isObj(first)) return null;
    const type = str(first['subscriptionType']);
    if (type === undefined) return null;
    const [object = '', rawAction = ''] = type.toLowerCase().split('.');
    const action = ACTIONS[rawAction.replace('_', '')];
    if (action === undefined || !(object in OBJECT_TYPES)) return null;
    const id = num(first['objectId']);
    const portal = num(first['portalId']);
    const name = str(first['propertyValue']);
    const batch = Array.isArray(body) && body.length > 1 ? ` (and ${body.length - 1} more in this delivery)` : '';
    return {
      kind: `${object}.${action}`,
      externalId: id === undefined ? '' : String(id),
      url: portal !== undefined && id !== undefined ? `https://app.hubspot.com/contacts/${portal}/record/${OBJECT_TYPES[object]}/${id}` : null,
      title: `${oneLine(name ?? `${object} ${id ?? ''}`, 180)}${batch}`,
      actor: '',
    };
  },
};
