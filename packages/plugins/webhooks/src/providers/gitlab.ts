import type { NormalisedProviderEvent, ProviderReader } from './index.ts';
import { at, isObj, oneLine, safeUrl, sameSecret, str, toMs } from './common.ts';

// GitLab (docs.gitlab.com "Webhooks"): the secret token is sent as it is in `X-Gitlab-Token` (no HMAC, so it is compared in constant time and never logged). `X-Gitlab-Event-UUID` is
// the delivery id. No timestamp comes with the proof: the dedupe window and the event's own time stop a replay.

const ISSUE: Record<string, string> = { open: 'issue.created', close: 'issue.closed', reopen: 'issue.updated', update: 'issue.updated' };
const MERGE: Record<string, string> = { open: 'merge_request.opened', reopen: 'merge_request.opened', close: 'merge_request.closed', merge: 'merge_request.merged', update: 'merge_request.updated' };

export const gitlab: ProviderReader = {
  provider: 'gitlab',
  verify({ headers, secret }) {
    const token = headers['x-gitlab-token'];
    return token !== undefined && sameSecret(secret, token) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  },
  deliveryKey: (headers) => str(headers['x-gitlab-event-uuid']) ?? str(headers['idempotency-key']) ?? null,
  eventTime(_headers, body) {
    const kind = at(body, 'object_kind');
    if (kind === 'issue' || kind === 'merge_request') return toMs(at(body, 'object_attributes', 'updated_at'));
    return null;
  },
  normalise({ body }): NormalisedProviderEvent | null {
    if (!isObj(body)) return null;
    const kind = str(body['object_kind']);
    const project = oneLine(at(body, 'project', 'name'), 100);
    const actor = oneLine(at(body, 'user', 'name') ?? body['user_name'], 80);
    const attrs = at(body, 'object_attributes');
    const action = str(at(attrs, 'action')) ?? '';
    if (kind === 'issue') {
      return { kind: ISSUE[action] ?? 'issue.updated', externalId: `${project}#${String(at(attrs, 'iid') ?? '')}`, url: safeUrl(at(attrs, 'url')), title: oneLine(at(attrs, 'title'), 200), actor };
    }
    if (kind === 'merge_request') {
      return { kind: MERGE[action] ?? 'merge_request.updated', externalId: `${project}!${String(at(attrs, 'iid') ?? '')}`, url: safeUrl(at(attrs, 'url')), title: oneLine(at(attrs, 'title'), 200), actor };
    }
    if (kind === 'push') {
      const commits = body['commits'];
      const first = Array.isArray(commits) ? commits[0] : undefined;
      const ref = oneLine(body['ref'], 120);
      return { kind: 'push', externalId: `${project}@${ref}`, url: safeUrl(at(first, 'url')) ?? safeUrl(at(body, 'project', 'web_url')), title: oneLine(at(first, 'message'), 200) || ref, actor };
    }
    return null;
  },
};
