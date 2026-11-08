import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { at, hexAfter, hmacHex, isObj, oneLine, safeUrl, sameHex, str, toMs, num } from './common.ts';

// GitHub (docs.github.com "Validating webhook deliveries"): `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, the event in `X-GitHub-Event`, the delivery id in
// `X-GitHub-Delivery`. GitHub sends no timestamp with the signature, so a replay is stopped by the dedupe window and by the event's own time.

const ISSUE_ACTIONS: Record<string, string> = { opened: 'issue.created', closed: 'issue.closed' };
const PULL_ACTIONS: Record<string, string> = { opened: 'pull_request.opened', closed: 'pull_request.closed', reopened: 'pull_request.opened' };

export const github: ProviderReader = {
  provider: 'github',
  verify({ headers, rawBody, secret }) {
    const presented = hexAfter(headers['x-hub-signature-256'], 'sha256=', 64);
    if (presented === null) return { ok: false, reason: 'bad_signature' };
    return sameHex(hmacHex('sha256', secret, rawBody), presented) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },
  deliveryKey: (headers) => str(headers['x-github-delivery']) ?? null,
  eventTime(headers, body) {
    const event = headers['x-github-event'];
    if (event === 'issues') return toMs(at(body, 'issue', 'updated_at'));
    if (event === 'issue_comment') return toMs(at(body, 'comment', 'created_at'));
    if (event === 'pull_request') return toMs(at(body, 'pull_request', 'updated_at'));
    // a push carries the commit's own time, which may be old (an old branch pushed today): no age check
    return null;
  },
  normalise({ headers, body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const event = headers['x-github-event'];
    const action = str(body['action']) ?? '';
    const repo = oneLine(at(body, 'repository', 'full_name'), 100);
    const actor = oneLine(at(body, 'sender', 'login') ?? at(body, 'pusher', 'name'), 80);
    if (event === 'issues') {
      const number = num(at(body, 'issue', 'number'));
      return {
        kind: ISSUE_ACTIONS[action] ?? 'issue.updated',
        externalId: `${repo}#${number ?? ''}`,
        url: safeUrl(at(body, 'issue', 'html_url')),
        title: oneLine(at(body, 'issue', 'title'), 200),
        actor,
      };
    }
    if (event === 'issue_comment') {
      if (action !== 'created') return null;
      return {
        kind: 'comment.created',
        externalId: `${repo}#${num(at(body, 'issue', 'number')) ?? ''}`,
        url: safeUrl(at(body, 'comment', 'html_url')),
        title: oneLine(at(body, 'issue', 'title'), 200),
        actor,
      };
    }
    if (event === 'pull_request') {
      const merged = at(body, 'pull_request', 'merged') === true;
      return {
        kind: merged && action === 'closed' ? 'pull_request.merged' : (PULL_ACTIONS[action] ?? 'pull_request.updated'),
        externalId: `${repo}#${num(at(body, 'pull_request', 'number')) ?? ''}`,
        url: safeUrl(at(body, 'pull_request', 'html_url')),
        title: oneLine(at(body, 'pull_request', 'title'), 200),
        actor,
      };
    }
    if (event === 'push') {
      const ref = oneLine(body['ref'], 120);
      return { kind: 'push', externalId: `${repo}@${ref}`, url: safeUrl(at(body, 'head_commit', 'url')) ?? safeUrl(at(body, 'repository', 'html_url')), title: oneLine(at(body, 'head_commit', 'message'), 200) || ref, actor };
    }
    // ping, check_run, workflow_run and the rest: understood and ignored
    return null;
  },
};
