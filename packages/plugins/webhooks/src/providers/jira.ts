import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { at, hexAfter, hmacHex, isObj, oneLine, safeUrl, sameHex, str, toMs } from './common.ts';

// Jira webhooks (developer.atlassian.com "Webhooks", secured with a secret): the body is signed as in WebSub, `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. The
// delivery id is `X-Atlassian-Webhook-Identifier`; the body carries `timestamp` (milliseconds) which is the event's own time.

const EVENTS: Record<string, string> = {
  'jira:issue_created': 'issue.created',
  'jira:issue_updated': 'issue.updated',
  'jira:issue_deleted': 'issue.deleted',
  comment_created: 'comment.created',
  comment_updated: 'comment.updated',
};

/** The address of the issue in Jira's own site, built from the origin of the API address Jira sends: `https://x.atlassian.net/rest/api/2/issue/10001` becomes `https://x.atlassian.net/browse/ENG-1`. */
function browseUrl(self: unknown, key: unknown): string | null {
  const api = safeUrl(self);
  const k = oneLine(key, 60);
  if (api === null || k === '') return null;
  return `${new URL(api).origin}/browse/${encodeURIComponent(k)}`;
}

export const jira: ProviderReader = {
  provider: 'jira',
  verify({ headers, rawBody, secret }) {
    const presented = hexAfter(headers['x-hub-signature'], 'sha256=', 64);
    if (presented === null) return { ok: false, reason: 'bad_signature' };
    return sameHex(hmacHex('sha256', secret, rawBody), presented) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },
  deliveryKey: (headers) => str(headers['x-atlassian-webhook-identifier']) ?? null,
  eventTime: (_headers, body) => toMs(at(body, 'timestamp')),
  normalise({ body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const event = str(body['webhookEvent']) ?? '';
    const kind = EVENTS[event];
    if (kind === undefined) return null;
    const issue = body['issue'];
    const key = at(issue, 'key');
    return {
      kind,
      externalId: oneLine(key, 60),
      url: browseUrl(at(issue, 'self'), key),
      title: oneLine(at(issue, 'fields', 'summary'), 200),
      actor: oneLine(at(body, 'user', 'displayName') ?? at(body, 'comment', 'author', 'displayName'), 80),
    };
  },
};
