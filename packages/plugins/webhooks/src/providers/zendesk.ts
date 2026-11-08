import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { WINDOW_MS, at, hmacBase64, isObj, kindFrom, oneLine, safeUrl, sameSecret, str, toMs, withinWindow } from './common.ts';

// Zendesk (developer.zendesk.com "Verifying webhook authenticity"): `X-Zendesk-Webhook-Signature` is the base64 HMAC-SHA256, under the webhook's signing secret, of the
// timestamp in `X-Zendesk-Webhook-Signature-Timestamp` followed by the raw body. The timestamp must be within five minutes. `X-Zendesk-Webhook-Invocation-Id` is the delivery id.

const PREFIX = 'zen:event-type:';

/** The page of the ticket in Zendesk's agent screen, built from the origin of the API address in the event. */
function agentUrl(api: unknown, id: unknown): string | null {
  const url = safeUrl(api);
  const ticket = oneLine(id, 30);
  if (url === null || ticket === '') return null;
  return `${new URL(url).origin}/agent/tickets/${encodeURIComponent(ticket)}`;
}

export const zendesk: ProviderReader = {
  provider: 'zendesk',
  verify({ headers, rawBody, secret, now }) {
    const stamp = headers['x-zendesk-webhook-signature-timestamp'];
    const presented = headers['x-zendesk-webhook-signature'];
    if (stamp === undefined || presented === undefined) return { ok: false, reason: 'bad_signature' };
    const expected = hmacBase64(secret, Buffer.concat([Buffer.from(stamp, 'utf8'), Buffer.from(rawBody)]));
    if (!sameSecret(expected, presented)) return { ok: false, reason: 'bad_signature' };
    const sent = toMs(stamp);
    return sent !== null && withinWindow(sent, now, WINDOW_MS) ? { ok: true } : { ok: false, reason: 'stale' };
  },
  deliveryKey: (headers) => str(headers['x-zendesk-webhook-invocation-id']) ?? null,
  normalise({ body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const type = str(body['type']);
    if (type === undefined || !type.startsWith(PREFIX)) return null;
    const kind = kindFrom(type.slice(PREFIX.length));
    if (kind === null) return null;
    const detail = body['detail'];
    const id = at(detail, 'id') ?? String(body['subject'] ?? '').replace('zen:ticket:', '');
    return {
      kind,
      externalId: oneLine(id, 60),
      url: agentUrl(at(detail, 'url'), id),
      title: oneLine(at(detail, 'subject'), 200),
      actor: oneLine(at(body, 'event', 'actor', 'name'), 80),
    };
  },
};
