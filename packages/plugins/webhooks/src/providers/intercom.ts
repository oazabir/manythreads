import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { at, hexAfter, hmacHex, isObj, kindFrom, oneLine, sameHex, str, stripTags, toMs } from './common.ts';

// Intercom (developers.intercom.com "Webhooks"): `X-Hub-Signature: sha1=<hex HMAC-SHA1 of the raw body>` with the app's client secret. The notification's own `id` is the delivery id
// and `created_at` (seconds) its time. Intercom sends no timestamp with the signature.

const TOPICS: Record<string, string> = {
  'conversation.user.created': 'conversation.created',
  'conversation.user.replied': 'conversation.replied',
  'contact.created': 'contact.created',
};

export const intercom: ProviderReader = {
  provider: 'intercom',
  verify({ headers, rawBody, secret }) {
    const presented = hexAfter(headers['x-hub-signature'], 'sha1=', 40);
    if (presented === null) return { ok: false, reason: 'bad_signature' };
    return sameHex(hmacHex('sha1', secret, rawBody), presented) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },
  deliveryKey: (_headers, body) => str(at(body, 'id')) ?? null,
  eventTime: (_headers, body) => toMs(at(body, 'created_at'), true),
  normalise({ body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const topic = str(body['topic']);
    if (topic === undefined) return null;
    const kind = TOPICS[topic] ?? kindFrom(topic);
    if (kind === null) return null;
    const item = at(body, 'data', 'item');
    const opening = stripTags(at(item, 'source', 'body'));
    return {
      kind,
      externalId: oneLine(at(item, 'id'), 60),
      url: null,
      title: oneLine(at(item, 'title'), 200) || oneLine(opening, 200) || oneLine(at(item, 'name'), 200),
      actor: oneLine(at(item, 'source', 'author', 'name') ?? at(item, 'name'), 80),
    };
  },
};
