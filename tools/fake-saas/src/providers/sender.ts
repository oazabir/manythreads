import { createHmac, randomUUID } from 'node:crypto';

/*
 * The signed-webhook sender (PLAN Bundle D, WP-0b). It builds a payload shaped like the provider's own and signs it the way the provider signs, so the door of the
 * webhooks plugin is proved against the real schemes and not against its own reading of them. The schemes, from each provider's documentation:
 *
 *   github    `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, body)>`, `X-GitHub-Event`, `X-GitHub-Delivery`
 *   gitlab    `X-Gitlab-Token: <secret>` (no HMAC), `X-Gitlab-Event`, `X-Gitlab-Event-UUID`
 *   jira      `X-Hub-Signature: sha256=<hex HMAC-SHA256(secret, body)>` (WebSub), `X-Atlassian-Webhook-Identifier`
 *   linear    `Linear-Signature: <hex HMAC-SHA256(secret, body)>`, `Linear-Delivery`, and the body's `webhookTimestamp` (milliseconds)
 *   zendesk   `X-Zendesk-Webhook-Signature: <base64 HMAC-SHA256(secret, timestamp + body)>` with `X-Zendesk-Webhook-Signature-Timestamp` (ISO 8601)
 *   intercom  `X-Hub-Signature: sha1=<hex HMAC-SHA1(client secret, body)>`
 *   hubspot   `X-HubSpot-Signature-v3: <base64 HMAC-SHA256(client secret, "POST" + uri + body + timestamp)>` with `X-HubSpot-Request-Timestamp` (milliseconds)
 *   asana     first a handshake (`X-Hook-Secret` in the request, echoed in the answer), then `X-Hook-Signature: <hex HMAC-SHA256(hook secret, body)>`
 *   generic   `X-Manythreads-Signature: v0=<hex HMAC-SHA256(secret, "v0:" + timestamp + ":" + body)>` with `X-Manythreads-Request-Timestamp` (seconds)
 *
 * `tamper` plays the ways a call goes wrong: `signature` (signed with another secret), `body` (the body changed after it was signed), `unsigned` (no proof at all),
 * `stale` (correctly signed but old: the provider's timestamp 10 minutes back, or for the providers that send none the event's own time 8 days back) and
 * `replay` (the same call, same delivery id, posted twice). Nothing here keeps the secret: it signs and is forgotten.
 */

export type WebhookProvider = 'github' | 'gitlab' | 'jira' | 'linear' | 'zendesk' | 'intercom' | 'hubspot' | 'asana' | 'generic';
export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = ['github', 'gitlab', 'jira', 'linear', 'zendesk', 'intercom', 'hubspot', 'asana', 'generic'];

export type Tamper = 'none' | 'signature' | 'stale' | 'replay' | 'body' | 'unsigned';
export const TAMPERS: readonly Tamper[] = ['none', 'signature', 'stale', 'replay', 'body', 'unsigned'];

/** The kinds each provider's sender knows, named as the webhooks plugin names them once normalised. */
export const WEBHOOK_KINDS: Record<WebhookProvider, readonly string[]> = {
  github: ['issue.created', 'issue.updated', 'issue.closed', 'comment.created', 'pull_request.opened', 'pull_request.closed', 'push'],
  gitlab: ['issue.created', 'issue.updated', 'merge_request.opened', 'push'],
  jira: ['issue.created', 'issue.updated', 'comment.created'],
  linear: ['issue.created', 'issue.updated', 'comment.created'],
  zendesk: ['ticket.created', 'ticket.status_changed', 'ticket.comment_added'],
  intercom: ['conversation.created', 'conversation.replied', 'contact.created'],
  hubspot: ['contact.created', 'ticket.created', 'deal.created'],
  asana: ['handshake', 'task.created', 'task.changed'],
  generic: [],
};

export interface SendWebhookOptions {
  provider: WebhookProvider;
  /** Where the call goes (for HubSpot the address is also part of what is signed). */
  url: string;
  /** The signing secret; for Asana the hook secret of the handshake; for GitLab the token itself. */
  secret: string;
  kind: string;
  tamper?: Tamper;
  /** The title of the ticket, issue or conversation. */
  title?: string;
  /** The number or key of the thing (default 4512). */
  ref?: string | number;
  /** The person who did it. */
  actor?: string;
  /** The clock of the call (default now). */
  now?: Date | string;
  /** Default: a fresh uuid. Give the same one to play a repeat. */
  deliveryId?: string;
  /** Sign exactly this text as the body (the payload is not built). For the vectors of a provider's documentation and for hostile sizes. */
  body?: string;
  /** Add padding to the payload so the body is at least this many bytes (a call that is too large). */
  padBytes?: number;
}

export interface BuiltWebhook {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
  deliveryId: string;
  /** How many times to post it (2 for `replay`). */
  repeat: number;
}

export interface WebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface SendWebhookResult {
  /** What was posted, without the body. */
  request: { url: string; headers: Record<string, string>; deliveryId: string; bodyBytes: number };
  responses: WebhookResponse[];
}

const hex = (algorithm: 'sha256' | 'sha1', secret: string, text: string): string => createHmac(algorithm, secret).update(text).digest('hex');
const b64 = (secret: string, text: string): string => createHmac('sha256', secret).update(text).digest('base64');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function asDate(now: Date | string | undefined): Date {
  const d = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error('now is not a date');
  return d;
}

/** The payload of a kind, shaped like the provider's, with `at` as the time the event happened. */
function payloadOf(o: SendWebhookOptions, at: Date, deliveryId: string, timestampMs: number): { body: Record<string, unknown>; headers: Record<string, string> } {
  const ref = String(o.ref ?? 4512);
  const title = o.title ?? 'Printer on fire';
  const actor = o.actor ?? 'Dana Customer';
  const iso = at.toISOString();
  const unix = Math.floor(at.getTime() / 1000);
  const unknown = (): never => {
    throw new Error(`${o.provider} has no kind "${o.kind}" (known: ${WEBHOOK_KINDS[o.provider].join(', ')})`);
  };
  switch (o.provider) {
    case 'github': {
      const repository = { id: 1, full_name: 'kahf-demo/lantern', html_url: 'https://github.com/kahf-demo/lantern' };
      const sender = { login: actor, id: 7, type: 'User' };
      const issue = (state: string): Record<string, unknown> => ({ number: Number(ref) || 1, title, state, html_url: `https://github.com/kahf-demo/lantern/issues/${ref}`, body: 'It prints a lot of smoke.', user: sender, created_at: iso, updated_at: iso });
      if (o.kind === 'issue.created') return { headers: { 'x-github-event': 'issues' }, body: { action: 'opened', issue: issue('open'), repository, sender } };
      if (o.kind === 'issue.updated') return { headers: { 'x-github-event': 'issues' }, body: { action: 'edited', issue: issue('open'), repository, sender } };
      if (o.kind === 'issue.closed') return { headers: { 'x-github-event': 'issues' }, body: { action: 'closed', issue: issue('closed'), repository, sender } };
      if (o.kind === 'comment.created') return { headers: { 'x-github-event': 'issue_comment' }, body: { action: 'created', issue: issue('open'), comment: { id: 99, body: title, user: sender, created_at: iso, html_url: `https://github.com/kahf-demo/lantern/issues/${ref}#issuecomment-99` }, repository, sender } };
      if (o.kind === 'pull_request.opened' || o.kind === 'pull_request.closed')
        return { headers: { 'x-github-event': 'pull_request' }, body: { action: o.kind === 'pull_request.opened' ? 'opened' : 'closed', number: Number(ref) || 1, pull_request: { number: Number(ref) || 1, title, state: o.kind === 'pull_request.opened' ? 'open' : 'closed', html_url: `https://github.com/kahf-demo/lantern/pull/${ref}`, user: sender, created_at: iso, updated_at: iso, head: { ref: 'fix-smoke' }, base: { ref: 'main' } }, repository, sender } };
      if (o.kind === 'push') return { headers: { 'x-github-event': 'push' }, body: { ref: 'refs/heads/main', before: '0'.repeat(40), after: 'a'.repeat(40), repository, pusher: { name: actor }, sender, head_commit: { id: 'a'.repeat(40), message: title, timestamp: iso, url: `https://github.com/kahf-demo/lantern/commit/${'a'.repeat(40)}` } } };
      return unknown();
    }
    case 'gitlab': {
      const user = { id: 7, name: actor, username: 'dana' };
      const project = { id: 1, name: 'lantern', web_url: 'https://gitlab.com/kahf-demo/lantern' };
      const attrs = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: 1, iid: Number(ref) || 1, title, created_at: iso, updated_at: iso, url: `https://gitlab.com/kahf-demo/lantern/-/issues/${ref}`, ...extra });
      if (o.kind === 'issue.created') return { headers: { 'x-gitlab-event': 'Issue Hook' }, body: { object_kind: 'issue', event_type: 'issue', user, project, object_attributes: attrs({ action: 'open', state: 'opened' }) } };
      if (o.kind === 'issue.updated') return { headers: { 'x-gitlab-event': 'Issue Hook' }, body: { object_kind: 'issue', event_type: 'issue', user, project, object_attributes: attrs({ action: 'update', state: 'opened' }) } };
      if (o.kind === 'merge_request.opened') return { headers: { 'x-gitlab-event': 'Merge Request Hook' }, body: { object_kind: 'merge_request', event_type: 'merge_request', user, project, object_attributes: attrs({ action: 'open', state: 'opened', url: `https://gitlab.com/kahf-demo/lantern/-/merge_requests/${ref}` }) } };
      if (o.kind === 'push') return { headers: { 'x-gitlab-event': 'Push Hook' }, body: { object_kind: 'push', event_name: 'push', ref: 'refs/heads/main', user_name: actor, project, commits: [{ id: 'b'.repeat(40), message: title, timestamp: iso, url: 'https://gitlab.com/kahf-demo/lantern/-/commit/' + 'b'.repeat(40) }], total_commits_count: 1 } };
      return unknown();
    }
    case 'jira': {
      const issue = { id: '10001', key: `ENG-${ref}`, self: 'https://kahf.atlassian.net/rest/api/2/issue/10001', fields: { summary: title, created: iso, updated: iso, status: { name: 'To Do' }, issuetype: { name: 'Bug' } } };
      const user = { displayName: actor, accountId: 'acc-7' };
      if (o.kind === 'issue.created') return { headers: {}, body: { timestamp: at.getTime(), webhookEvent: 'jira:issue_created', issue_event_type_name: 'issue_created', user, issue } };
      if (o.kind === 'issue.updated') return { headers: {}, body: { timestamp: at.getTime(), webhookEvent: 'jira:issue_updated', issue_event_type_name: 'issue_generic', user, issue, changelog: { items: [{ field: 'summary', toString: title }] } } };
      if (o.kind === 'comment.created') return { headers: {}, body: { timestamp: at.getTime(), webhookEvent: 'comment_created', issue, comment: { id: '20001', author: user, body: title, created: iso } } };
      return unknown();
    }
    case 'linear': {
      const base = { organizationId: 'org-1', webhookTimestamp: timestampMs, webhookId: 'wh-1', createdAt: iso, url: `https://linear.app/kahf/issue/ENG-${ref}` };
      const data = { id: 'iss-1', identifier: `ENG-${ref}`, title, createdAt: iso, updatedAt: iso, state: { name: 'Todo' } };
      if (o.kind === 'issue.created') return { headers: { 'linear-event': 'Issue' }, body: { action: 'create', type: 'Issue', actor: { id: 'u-7', name: actor }, data, ...base } };
      if (o.kind === 'issue.updated') return { headers: { 'linear-event': 'Issue' }, body: { action: 'update', type: 'Issue', actor: { id: 'u-7', name: actor }, data, updatedFrom: { title: 'Old title' }, ...base } };
      if (o.kind === 'comment.created') return { headers: { 'linear-event': 'Comment' }, body: { action: 'create', type: 'Comment', actor: { id: 'u-7', name: actor }, data: { id: 'c-1', body: title, issueId: 'iss-1', createdAt: iso }, ...base } };
      return unknown();
    }
    case 'zendesk': {
      const kinds: Record<string, string> = { 'ticket.created': 'zen:event-type:ticket.created', 'ticket.status_changed': 'zen:event-type:ticket.status_changed', 'ticket.comment_added': 'zen:event-type:ticket.comment_added' };
      const type = kinds[o.kind];
      if (!type) return unknown();
      return {
        headers: { 'x-zendesk-webhook-id': '01HZ-FAKE-WEBHOOK', 'x-zendesk-webhook-invocation-id': deliveryId, 'x-api-account-id': '10101', 'x-api-user-id': '20202' },
        body: {
          type,
          id: deliveryId,
          time: iso,
          account_id: 10101,
          subject: `zen:ticket:${ref}`,
          zendesk_event_version: '2022-11-06',
          detail: { id: String(ref), subject: title, status: 'NEW', priority: 'NORMAL', requester_id: '30303', created_at: iso, brand_id: '1', description: 'The printer is smoking.', url: `https://kahf.zendesk.com/api/v2/tickets/${ref}.json` },
          event: o.kind === 'ticket.status_changed' ? { current: 'OPEN', previous: 'NEW' } : {},
        },
      };
    }
    case 'intercom': {
      const topics: Record<string, string> = { 'conversation.created': 'conversation.user.created', 'conversation.replied': 'conversation.user.replied', 'contact.created': 'contact.created' };
      const topic = topics[o.kind];
      if (!topic) return unknown();
      const item =
        o.kind === 'contact.created'
          ? { type: 'contact', id: `c-${ref}`, role: 'user', name: actor, email: 'dana@customer.example', created_at: unix }
          : { type: 'conversation', id: String(ref), created_at: unix, updated_at: unix, title, state: 'open', source: { type: 'conversation', body: `<p>${title}</p>`, author: { type: 'user', name: actor } } };
      return { headers: {}, body: { type: 'notification_event', app_id: 'app-1', id: `notif_${deliveryId}`, topic, created_at: unix, delivery_attempts: 1, first_sent_at: unix, data: { type: 'notification_event_data', item } } };
    }
    case 'hubspot': {
      const types: Record<string, string> = { 'contact.created': 'contact.creation', 'ticket.created': 'ticket.creation', 'deal.created': 'deal.creation' };
      const type = types[o.kind];
      if (!type) return unknown();
      return {
        headers: {},
        // HubSpot posts an array of events; the numeric `eventId` is the delivery key of the first
        body: [{ eventId: Number.parseInt(deliveryId.replaceAll('-', '').slice(0, 12), 16), subscriptionId: 1234, portalId: 8888, appId: 5555, occurredAt: at.getTime(), subscriptionType: type, attemptNumber: 0, objectId: Number(ref) || 1, changeSource: 'CRM', propertyName: 'subject', propertyValue: title }] as unknown as Record<string, unknown>,
      };
    }
    case 'asana': {
      if (o.kind === 'task.created' || o.kind === 'task.changed')
        return { headers: {}, body: { events: [{ user: { gid: '7', resource_type: 'user', name: actor }, created_at: iso, action: o.kind === 'task.created' ? 'added' : 'changed', resource: { gid: String(ref), resource_type: 'task', name: title }, parent: { gid: '300', resource_type: 'project' } }] } };
      return unknown();
    }
    case 'generic':
      return { headers: {}, body: { id: deliveryId, kind: o.kind, title, url: `https://example.test/things/${ref}`, actor, at: iso } };
  }
}

/** Builds the call: payload, headers and proof, with `tamper` applied. */
export function buildWebhook(options: SendWebhookOptions): BuiltWebhook {
  const o = options;
  const tamper: Tamper = o.tamper ?? 'none';
  if (!TAMPERS.includes(tamper)) throw new Error(`unknown tamper "${tamper}"`);
  if (!WEBHOOK_PROVIDERS.includes(o.provider)) throw new Error(`unknown provider "${o.provider}"`);
  const now = asDate(o.now);
  const deliveryId = o.deliveryId ?? randomUUID();
  const stale = tamper === 'stale';
  // providers with a timestamp in the proof send an old one; the others an event time 8 days old (the door's own window is 7 days)
  const timestampDate = stale ? new Date(now.getTime() - 10 * MINUTE) : now;
  const eventTime = stale && ['github', 'gitlab', 'jira', 'intercom', 'asana'].includes(o.provider) ? new Date(now.getTime() - 8 * DAY) : now;
  const handshake = o.provider === 'asana' && o.kind === 'handshake';
  const built = handshake ? { headers: {} as Record<string, string>, body: {} as Record<string, unknown> } : payloadOf(o, eventTime, deliveryId, timestampDate.getTime());
  if (o.padBytes !== undefined && o.padBytes > 0 && !Array.isArray(built.body)) built.body['padding'] = 'x'.repeat(o.padBytes);

  let body = o.body ?? JSON.stringify(built.body);
  if (o.padBytes !== undefined && o.padBytes > 0 && o.body === undefined && Array.isArray(built.body)) body = JSON.stringify([...(built.body as unknown[]), { padding: 'x'.repeat(o.padBytes) }]);
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'user-agent': `fake-saas-${o.provider}`, ...built.headers };
  // `signature` is signed with a secret that is not the one the receiver holds
  const key = tamper === 'signature' ? `${o.secret}-not-the-secret` : o.secret;
  const target = o.url;

  switch (o.provider) {
    case 'github':
      headers['x-github-delivery'] = deliveryId;
      headers['x-hub-signature-256'] = `sha256=${hex('sha256', key, body)}`;
      break;
    case 'gitlab':
      headers['x-gitlab-token'] = key;
      headers['x-gitlab-event-uuid'] = deliveryId;
      headers['idempotency-key'] = deliveryId;
      break;
    case 'jira':
      headers['x-atlassian-webhook-identifier'] = deliveryId;
      headers['x-hub-signature'] = `sha256=${hex('sha256', key, body)}`;
      break;
    case 'linear':
      headers['linear-delivery'] = deliveryId;
      headers['linear-signature'] = hex('sha256', key, body);
      break;
    case 'zendesk': {
      const stamp = timestampDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
      headers['x-zendesk-webhook-signature-timestamp'] = stamp;
      headers['x-zendesk-webhook-signature'] = b64(key, stamp + body);
      break;
    }
    case 'intercom':
      headers['x-hub-signature'] = `sha1=${hex('sha1', key, body)}`;
      break;
    case 'hubspot': {
      const stamp = String(timestampDate.getTime());
      headers['x-hubspot-request-timestamp'] = stamp;
      headers['x-hubspot-signature-v3'] = b64(key, `POST${target}${body}${stamp}`);
      break;
    }
    case 'asana':
      if (handshake) headers['x-hook-secret'] = o.secret;
      else headers['x-hook-signature'] = hex('sha256', key, body);
      break;
    case 'generic': {
      const stamp = String(Math.floor(timestampDate.getTime() / 1000));
      headers['x-manythreads-request-timestamp'] = stamp;
      headers['x-manythreads-signature'] = `v0=${hex('sha256', key, `v0:${stamp}:${body}`)}`;
      break;
    }
  }

  if (tamper === 'unsigned') {
    for (const name of ['x-hub-signature-256', 'x-hub-signature', 'x-gitlab-token', 'linear-signature', 'x-zendesk-webhook-signature', 'x-zendesk-webhook-signature-timestamp', 'x-hubspot-signature-v3', 'x-hubspot-request-timestamp', 'x-hook-signature', 'x-hook-secret', 'x-manythreads-signature', 'x-manythreads-request-timestamp']) delete headers[name];
  }
  // the body changes after the proof was made, by one character that keeps it valid JSON
  if (tamper === 'body') body = body.endsWith('}') || body.endsWith(']') ? `${body.slice(0, -1)} ${body.slice(-1)}` : `${body} `;
  return { method: 'POST', url: target, headers, body, deliveryId, repeat: tamper === 'replay' ? 2 : 1 };
}

/** Builds the call and posts it (twice for `replay`). Redirects are not followed; the answer's body is cut to 2 KB. */
export async function sendWebhook(options: SendWebhookOptions): Promise<SendWebhookResult> {
  const call = buildWebhook(options);
  const responses: WebhookResponse[] = [];
  for (let i = 0; i < call.repeat; i++) {
    const r = await fetch(call.url, { method: call.method, headers: call.headers, body: call.body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const headers: Record<string, string> = {};
    r.headers.forEach((value, name) => {
      if (name !== 'set-cookie') headers[name] = value;
    });
    responses.push({ status: r.status, headers, body: (await r.text()).slice(0, 2048) });
  }
  return { request: { url: call.url, headers: call.headers, deliveryId: call.deliveryId, bodyBytes: Buffer.byteLength(call.body) }, responses };
}
