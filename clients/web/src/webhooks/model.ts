import type { ApiToken, OutgoingHook, Webhook } from '@manythreads/shared';

/** "just now", "5 minutes ago", "3 days ago" -- plain words for when a webhook was last used. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** What the "last used" line says for a webhook. */
export function useLine(h: Pick<Webhook, 'lastUsedAt' | 'lastStatus' | 'postedCount'>, now: number = Date.now()): string {
  if (h.lastUsedAt === null) return 'Never used yet';
  const when = ago(h.lastUsedAt, now);
  const posted = `${h.postedCount} ${h.postedCount === 1 ? 'message' : 'messages'} posted`;
  if (h.lastStatus === 'failed') return `Last call ${when} could not be posted · ${posted}`;
  if (h.lastStatus === 'ignored') return `Last call ${when} was skipped (an event this webhook does not show) · ${posted}`;
  return `Last used ${when} · ${posted}`;
}

/** A copy-and-paste example for the address `url` (the real one just after it is made, a placeholder otherwise). */
export function curlExample(url: string): string {
  return [`curl -X POST '${url}' \\`, `  -H 'Content-Type: application/json' \\`, `  -d '{"title": "Build finished", "text": "All checks passed on main", "status": "success", "url": "https://ci.example.com/runs/42"}'`].join('\n');
}

/** The sentence an error shows: the server's own plain-language message when it sent one. */
export const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

export const PLACEHOLDER_URL ='https://your-site.example/hooks/<id>/<secret>';

// ---- API tokens and outgoing webhooks (P14-14) ----------------------------------------------------------------

/** The plain names of the four methods a token may be allowed, as the dialog shows them. */
export const METHOD_LABELS: Record<string, string> = {
  'chat.postMessage': 'Post messages',
  'chat.update': 'Edit the messages it posted',
  'reactions.add': 'Add reactions',
  'reactions.remove': 'Remove reactions',
};

/** What the "last used" line says for an API token. */
export function tokenUseLine(t: Pick<ApiToken, 'lastUsedAt' | 'lastStatus' | 'callCount'>, now: number = Date.now()): string {
  if (t.lastUsedAt === null) return 'Never used yet';
  const calls = `${t.callCount} ${t.callCount === 1 ? 'call' : 'calls'} so far`;
  const when = ago(t.lastUsedAt, now);
  if (t.lastStatus === 'failed') return `Last call ${when} was refused · ${calls}`;
  return `Last used ${when} · ${calls}`;
}

/** A copy-and-paste example for a token: `base` ends with a slash, `channel` is the channel id. */
export function tokenCurlExample(base: string, secret: string, channel: string): string {
  return [
    `curl -X POST '${base}chat.postMessage' \\`,
    `  -H 'Authorization: Bearer ${secret}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"channel": "${channel}", "text": "Hello from a script"}'`,
  ].join('\n');
}

/** The trigger words as typed (commas or new lines between) → the list the server wants: trimmed, no empties, no repeats (capitals ignored), at most `max`. */
export function parseTriggerWords(input: string, max = 10): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const word = raw.trim();
    const key = word.toLowerCase();
    if (word === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/** A short reason from the server in words (`status_503` becomes "the receiver answered 503"). */
export function errorWords(reason: string | null): string {
  if (reason === null || reason === '') return 'unknown reason';
  const status = /^status_(\d{3})$/.exec(reason);
  if (status) return `the receiver answered ${status[1] ?? ''}`;
  const known: Record<string, string> = {
    timeout: 'no answer within 5 seconds',
    network: 'the connection failed',
    dns_failed: 'the address could not be found',
    blocked_address: 'the address leads inside a private network',
    blocked_host: 'the address is a local name',
    blocked_port: 'only ports 80 and 443 are used',
    blocked_by_policy: 'the workspace rules do not allow sending there',
    too_many_redirects: 'too many redirects',
    bad_redirect: 'a redirect that cannot be followed',
    rate_limited: 'too many messages in a minute',
  };
  return known[reason] ?? reason.replaceAll('_', ' ');
}

/** What the "last delivery" line says for an outgoing webhook. */
export function deliveryLine(
  h: Pick<OutgoingHook, 'lastDeliveryAt' | 'lastDeliveryStatus' | 'lastError' | 'deliveredCount' | 'failedCount'>,
  now: number = Date.now(),
): string {
  if (h.lastDeliveryAt === null || h.lastDeliveryStatus === null) return 'Nothing sent yet';
  const when = ago(h.lastDeliveryAt, now);
  const totals = `${h.deliveredCount} sent · ${h.failedCount} given up on`;
  if (h.lastDeliveryStatus === 'dead') return `Last try ${when} failed for good (${errorWords(h.lastError)}) · ${totals}`;
  if (h.lastDeliveryStatus === 'retrying') return `Last try ${when} failed (${errorWords(h.lastError)}); trying again · ${totals}`;
  return `Last message sent ${when} · ${totals}`;
}

/** How to check the signature on the receiving side, as a short Node example. */
export const VERIFY_EXAMPLE = [
  "const crypto = require('node:crypto');",
  'function isFromManythreads(secret, headers, rawBody) {',
  "  const stamp = headers['x-manythreads-request-timestamp'];",
  "  const expected = 'v0=' + crypto.createHmac('sha256', secret).update('v0:' + stamp + ':' + rawBody).digest('hex');",
  "  const got = Buffer.from(headers['x-manythreads-signature'] || '');",
  '  return got.length === expected.length && crypto.timingSafeEqual(got, Buffer.from(expected));',
  '}',
].join('\n');
