/**
 * The routes that grant, recover or change a credential or a session, with the explicit low limit each one carries (PLAN D5, task P10-14).
 * One list: the routes read their number from `abuseLimit`, the burst tests walk the whole list, and a test keeps
 * `docs/deploy/rate-limits.md` in step with it. A new route of this kind is added here in the same change that adds the route.
 *
 * Counters live in process memory of one server replica (PLAN D3), never in the database.
 *   - `address`: per client address, even for a signed-in caller (`rateLimitBy: 'address'`).
 *   - `person`: per signed-in person (the route needs a session; a NAT'd team does not share the counter).
 *   - `failures`: only failed attempts with the secret count, per client address; the route answers 401 until `limit` failures
 *     inside the window, and 429 with `retry-after` after that.
 */
export type AbuseKey = 'address' | 'person' | 'failures';

export interface AbuseRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  limit: number;
  windowMs: number;
  key: AbuseKey;
  /** The secret on the route that is guessed, and what happens after repeated failures (empty: nothing to guess). */
  lockout?: string;
}

const MIN = 60_000;

const r = (
  method: AbuseRoute['method'],
  path: string,
  limit: number,
  key: AbuseKey,
  lockout?: string,
  windowMs: number = MIN,
): AbuseRoute => ({ method, path, limit, windowMs, key, ...(lockout ? { lockout } : {}) });

export const ABUSE_ROUTES: readonly AbuseRoute[] = [
  // Sign-in and recovery: nobody is signed in, so the client address is the only thing to count.
  r('POST', '/api/auth/password/sign-in', 30, 'address', 'password: 5 failures per email and address lock that pair for 15 minutes; 25 per email from any address lock the account for 15 minutes'),
  r('POST', '/api/auth/password/reset-request', 5, 'address'),
  r('POST', '/api/auth/password/reset', 5, 'address', 'link token: 10 refused links per address in 15 minutes lock the address for 15 minutes'),
  r('POST', '/api/auth/email/verify', 10, 'address', 'link token: 10 refused links per address in 15 minutes lock the address for 15 minutes'),
  r('GET', '/api/bootstrap/:token', 10, 'address', 'setup token: 10 refused tokens per address in 15 minutes lock the address for 15 minutes'),
  r('POST', '/api/bootstrap/:token', 5, 'address', 'setup token: 10 refused tokens per address in 15 minutes lock the address for 15 minutes'),
  r('GET', '/api/invitations/:token', 10, 'address', 'invitation token: 10 refused tokens per address in 15 minutes lock the address for 15 minutes'),
  r('POST', '/api/invitations/:token/accept', 10, 'address', 'invitation token: 10 refused tokens per address in 15 minutes lock the address for 15 minutes'),
  r('GET', '/api/auth/oidc/:providerId/start', 30, 'address'),
  r('GET', '/api/auth/oidc/callback', 30, 'address', 'one-time state: single use and bound to the browser cookie'),
  // The signed-in person's own credential and sessions.
  r('POST', '/api/auth/password/change', 5, 'person', 'current password: 5 wrong guesses lock the change for that person for 15 minutes'),
  r('POST', '/api/auth/email/verify-request', 5, 'person'),
  r('POST', '/api/auth/sign-out', 30, 'person'),
  r('POST', '/api/auth/sign-out-everywhere', 10, 'person'),
  r('GET', '/api/auth/sessions', 60, 'person'),
  r('DELETE', '/api/auth/sessions/:id', 30, 'person'),
  // Tokens and secrets a person mints for a bot, a runner, a webhook or an embedded app.
  r('POST', '/api/teams/:slug/invitations', 30, 'person'),
  r('POST', '/api/invitations', 30, 'person'),
  r('POST', '/api/teams/:slug/bots/:botSlug/pairing-tokens', 10, 'person'),
  r('POST', '/api/teams/:slug/bots/:botSlug/pairing-tokens/rotate', 10, 'person'),
  r('DELETE', '/api/teams/:slug/bots/:botSlug/pairing-tokens', 30, 'person'),
  r('POST', '/api/teams/:slug/runners/:runnerId/token', 30, 'person'),
  r('DELETE', '/api/teams/:slug/runners/:runnerId/token', 30, 'person'),
  r('POST', '/api/channels/:channelId/webhooks', 30, 'person'),
  r('POST', '/api/webhooks/:webhookId/rotate', 30, 'person'),
  r('DELETE', '/api/webhooks/:webhookId', 30, 'person'),
  r('POST', '/api/webhooks/:webhookId/signing-secret', 30, 'person'),
  r('DELETE', '/api/webhooks/:webhookId/signing-secret', 30, 'person'),
  r('POST', '/api/channels/:channelId/api-tokens', 30, 'person'),
  r('POST', '/api/api-tokens/:tokenId/rotate', 30, 'person'),
  r('DELETE', '/api/api-tokens/:tokenId', 30, 'person'),
  r('POST', '/api/outgoing-hooks/:hookId/signing-secret', 30, 'person'),
  r('DELETE', '/api/outgoing-hooks/:hookId/signing-secret', 30, 'person'),
  r('POST', '/api/teams/:slug/repo/app-token', 120, 'person'),
  r('PUT', '/api/teams/:slug/projects/:projectId/push-credential', 20, 'person'),
  r('POST', '/api/teams/:slug/hermes/connections', 20, 'person'),
  // Runners (P19-02): a workspace admin makes, changes, tests and adopts a place bots run; a Hermes gateway's key is written here and never read back.
  r('POST', '/api/admin/bot-runners', 20, 'person'),
  r('PATCH', '/api/admin/bot-runners/:id', 30, 'person'),
  r('POST', '/api/admin/bot-runners/:id/test', 20, 'person'),
  // Claude Code sign-in (P19-06): the file is sealed in the pod's Secret and never read back.
  r('PUT', '/api/admin/bot-runners/:id/credentials', 20, 'person'),
  r('DELETE', '/api/admin/bot-runners/:id/credentials', 20, 'person'),
  r('POST', '/api/admin/bot-runners/:id/check', 20, 'person'),
  r('PUT', '/api/admin/bot-runners/default', 30, 'person'),
  r('POST', '/api/admin/bot-runners/old-connections/:connectionId/adopt', 20, 'person'),
  // Connections (P8-06): a workspace admin adds a team's connection and puts its credential in; the value is sealed and never read back.
  r('POST', '/api/teams/:slug/connections', 20, 'person'),
  r('PATCH', '/api/connections/:id', 30, 'person'),
  r('PUT', '/api/connections/:id/credentials/:name', 20, 'person'),
  r('DELETE', '/api/connections/:id', 30, 'person'),
  // A person's own sign-in to Google, Microsoft or Notion (P8-02): the start writes a one-time state; the callback trades the provider's code, which is also single
  // use and bound to the person that started it; a disconnect revokes and deletes the sealed tokens.
  r('POST', '/api/me/connections/:provider/start', 20, 'person'),
  r('GET', '/api/me/connections/:provider/callback', 30, 'person', 'one-time state: single use, bound to the person who started it, ten minutes'),
  r('DELETE', '/api/me/connections/:provider', 30, 'person'),
  // The OAuth app a workspace admin enters for a provider (P16-02): the client secret is sealed on the way in and never read back.
  r('PUT', '/api/admin/connections/oauth-apps/:provider', 20, 'person'),
  r('DELETE', '/api/admin/connections/oauth-apps/:provider', 20, 'person'),
  // Work-app endpoints (Bundle D, P16-10): a lead makes, rotates or gives a signing secret to an address a work app calls; the secret is sealed and never read back.
  r('POST', '/api/channels/:channelId/provider-hooks', 10, 'person'),
  r('POST', '/api/provider-hooks/:endpointId/rotate', 10, 'person'),
  r('PUT', '/api/provider-hooks/:endpointId/signing-secret', 10, 'person'),
  // Chat apps (Bundle D, P16-09): a person asks for a one-time code to prove a chat user is theirs (5 in 10 minutes), a lead for the code that joins a channel; an admin puts the bot's credential in (sealed, never read back).
  r('POST', '/api/me/bridges/:provider/link-code', 5, 'person', 'one-time code: 8 digits, ten minutes, single use; a chat gets 5 wrong codes in 15 minutes before it is locked out', 10 * MIN),
  r('POST', '/api/channels/:channelId/bridge-links/:provider/code', 5, 'person', 'one-time code: 8 digits, ten minutes, single use; a chat gets 5 wrong codes in 15 minutes before it is locked out', 10 * MIN),
  r('PUT', '/api/admin/bridges/:provider/credentials', 20, 'person'),
  // Leaving people (Bundle D, P16-11): an admin removes every connection of a person who is leaving; each one is revoked at its provider.
  r('POST', '/api/admin/people/:personId/offboard-connections', 10, 'person'),
  // Voice rooms (P15-03): starting a room and joining or renewing mint a media token (a credential that lets a browser into the room); the media server's signed
  // notices come in on a public address and are believed only with a valid signature.
  r('POST', '/api/channels/:channelId/meetings', 10, 'person'),
  r('POST', '/api/meetings/:meetingId/join', 60, 'person'),
  r('POST', '/api/meetings/:meetingId/token', 60, 'person'),
  r('POST', '/api/scheduled-meetings/:scheduledMeetingId/join', 60, 'person'),
  r('POST', '/api/meetings/media-webhook', 120, 'address', 'media server signature: a call without a valid signature answers 401 and changes nothing'),
  // A person answering a bot's screen (P9-04): one history line the bot reads later; the screen's own checks refuse anything the part did not declare.
  r('POST', '/api/channels/:channelId/surfaces/:surfaceId/events', 60, 'person'),
  // A part of a screen reading its bound data as the person looking (P9-06): one read tool call as the viewer, on a clock of at least 10 s per part.
  r('POST', '/api/channels/:channelId/surfaces/:surfaceId/data/:nodeId', 120, 'person'),
  // Machine credentials presented to a public address: the secret is long and random, so the limit counts only the failed guesses.
  r('POST', '/api/mcp/runs', 60, 'address', 'pairing token: failures counted below'),
  r('POST', '/api/mcp/bots/:botId', 60, 'failures', 'bot token: 60 failures per address a minute'),
  r('POST', '/mcp', 60, 'failures', 'bot or run token: 60 failures per address a minute'),
  r('POST', '/api/llm/runs/:runId/v1/chat/completions', 60, 'failures', 'run token: 60 failures per address a minute'),
  r('GET', '/api/runners/connect', 60, 'address', 'runner token'),
  r('POST', '/hooks/:webhookId/:secret', 600, 'address', 'webhook secret: 256-bit address; a refused call is recorded per webhook'),
  r('POST', '/hooks/apps/:endpointId', 600, 'address', 'provider signature: a call without a valid signature answers 401 and changes nothing; a refused call is recorded per endpoint'),
  r('POST', '/hooks/bridges/:provider/:accountId', 600, 'address', 'chat app signature or secret header: a call without a valid one answers 401 and changes nothing; a refused call is counted per account'),
  r('GET', '/hooks/bridges/:provider/:accountId', 600, 'address', 'chat app challenge: answers only a challenge with the right signature'),
  // The Slack-shaped API: the integration token is 256 random bits and each token has its own limit (60 calls a minute). The route has no per-address counter
  // of its own: only a call with an unknown token counts (30 in 5 minutes lock the address for 5 minutes), so junk from a shared address never refuses a valid caller.
  ...(['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove', 'auth.test'] as const).map((m) =>
    r('POST', `/api/slack/${m}`, 30, 'failures', 'API token: 30 calls with an unknown token in 5 min lock the address 5 min', 5 * MIN),
  ),
  r('GET', '/api/slack/auth.test', 30, 'failures', 'API token: same lock as the POST line above', 5 * MIN),
];

/** The limit of a registered route, for `ctx.http.route({ rateLimit })`. Throws for a route that is not on the list: add it above first. */
export function abuseLimit(method: AbuseRoute['method'], path: string): { limit: number; windowMs: number } {
  const found = ABUSE_ROUTES.find((a) => a.method === method && a.path === path);
  if (!found) throw new Error(`${method} ${path} is not in ABUSE_ROUTES (packages/shared/src/common/abuse-limits.ts)`);
  return { limit: found.limit, windowMs: found.windowMs };
}

/** Failures of a secret a client address may make before the temporary lock, and for how long (mailed links, setup and invitation tokens, the test sign-in). */
export const TOKEN_FAILURE_LOCK = { max: 10, windowMs: 15 * MIN, lockMs: 15 * MIN } as const;
/** Password sign-in: failures per email + address, and per email from any address (tripped later, so one stranger cannot lock out an owner cheaply). */
export const PASSWORD_ADDRESS_LOCK = { max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN } as const;
export const PASSWORD_ACCOUNT_LOCK = { max: 25, windowMs: 15 * MIN, lockMs: 15 * MIN } as const;
/** Wrong current passwords in change-password per person. */
export const CHANGE_PASSWORD_LOCK = { max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN } as const;
/** Calls to `/hooks/<id>/<secret>` that name no live webhook or carry a wrong secret, per client address (senders share addresses, so the count is higher and the lock shorter). */
export const WEBHOOK_FAILURE_LOCK = { max: 30, windowMs: 5 * MIN, lockMs: 5 * MIN } as const;

/**
 * What a limit or a lock counts a client address as. An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) is the IPv4 address; any other IPv6
 * address is its /64 network (the part a household or an office is handed whole: one machine can use billions of addresses inside it, so
 * counting each would give a guesser a fresh counter per request). Anything that is not an address comes back trimmed and lower-cased.
 */
export function addressKey(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!raw.includes(':')) return raw;
  // Turn an IPv4 tail into two groups, expand `::`, and look at the eight 16-bit groups.
  let text = raw;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = [tail[1], tail[2], tail[3], tail[4]].map(Number) as [number, number, number, number];
    if (a > 255 || b > 255 || c > 255 || d > 255) return raw;
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return raw;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(fill).fill('0') : []), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return raw;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
