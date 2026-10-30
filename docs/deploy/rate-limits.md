# Rate limits and lockouts on credential routes

Every route that grants, recovers or changes a credential or a session carries an explicit, low limit. This page lists each one: the
number, the window, what it is counted per, and the lockout that follows repeated wrong guesses. Over a limit the answer is
`429` with the error code `rate_limited` and a `retry-after` header (whole seconds). The numbers live in one list in the code
(`ABUSE_ROUTES` in `packages/shared/src/common/abuse-limits.ts`); a test fails if this page and that list drift apart, and
`packages/server/test/abuse.test.ts` bursts every route past its limit and checks the `429` and the header.

**Per replica.** All counters are kept in the memory of one server process (PLAN D3), never in the database. With more than one
server replica each replica counts alone, so the effective limit is the number below times the number of replicas, and a restart
clears every counter and every lock. The chart runs one replica today (`docs/deploy.md`). Nothing here is shared across replicas.

**Which address.** "Per address" means the client address the server derives, not what the client writes. The server trusts the
`X-Forwarded-For` header only for as many proxy hops as `MANYTHREADS_TRUST_PROXY` says (the chart: `server.trustProxy`, 2 for
Traefik plus the web pod's nginx; one more behind Cloudflare). Entries a client wrote in front of the proxies' own entries are ignored,
so a client that sends a made-up `X-Forwarded-For` keeps the same counter (tested). An IPv6 client is counted by its /64 network and an
IPv4-mapped IPv6 address as the IPv4 one, so a visitor cannot get a fresh counter by changing the low bits. Three cautions: (1) with no proxy hops configured
the header is ignored entirely, so every visitor behind a proxy would share one counter, the proxy's; (2) a workload inside the cluster
that calls the server's own Service directly, bypassing the ingress and nginx, can pick its own address, because there is no proxy to
append the real one. The chart's team pods cannot do this (their namespace denies every private address, so they reach the server only through the public address and the proxies); keep it that way for any other workload you add; (3) **a k3s node whose Traefik Service has `externalTrafficPolicy: Cluster` (the k3s default) rewrites
the source address of every connection to the node's bridge address (`10.42.0.1`), so the forwarded chain says that address for every visitor, whatever the
hop count.** Found on the live site on 2026-10-30: nginx in the web pod logged `X-Forwarded-For: 10.42.0.1` for a request that came through Cloudflare. Behind
Cloudflare the chart therefore also sets `MANYTHREADS_CLIENT_IP_HEADER=cf-connecting-ip` (a header Cloudflare writes itself; the server uses it when it is
one valid address and ignores a made-up one); outside Cloudflare, give the Traefik Service `externalTrafficPolicy: Local` (and keep the hop count), or the
limits and locks are shared by everyone. Because the header is only trustworthy when nobody but Cloudflare can reach the origin, close the origin to
Cloudflare's ranges (`docs/deploy.md`, Cloudflare step 6). The workspace HTTPS check (Settings > Workspace) shows the address the server derived.

**NAT.** A whole team behind one office address shares each "per address" counter. The numbers are chosen so that ordinary use
(a few sign-ins, a link or two a minute) never reaches them, while a guessing script does within seconds. Counters that guard a
secret someone could guess are tighter per account (the lockouts below), not per address.

## Routes

"Key" is what the counter is per: **address** (client address, even for a signed-in caller), **person** (the signed-in person, so an
office behind one address does not share it), or **failures** (only wrong secrets count, per client address; the route answers `401`
until the limit and `429` after). "Before" is the limit before task P10-14; "none" means the route had no limit of its own.

| Route | Before | Limit | Window | Key | Lockout after wrong guesses |
|---|---|---|---|---|---|
| `POST /api/auth/password/sign-in` | 60 per 60 s (actor, else address) | 30 per 60 s | 60 s | address | 5 failures per email and address lock that pair 15 min; 25 failures per email from any address lock the account 15 min |
| `POST /api/auth/password/reset-request` | 10 per 60 s | 5 per 60 s | 60 s | address | none (also: one mail per account per minute) |
| `POST /api/auth/password/reset` | 20 per 60 s | 5 per 60 s | 60 s | address | 10 refused links per address in 15 min lock the address 15 min; a good reset lifts the account's sign-in lock |
| `POST /api/auth/email/verify` | 20 per 60 s | 10 per 60 s | 60 s | address | 10 refused links per address in 15 min lock the address 15 min |
| `GET /api/bootstrap/:token` | 30 per 60 s | 10 per 60 s | 60 s | address | 10 refused tokens per address in 15 min lock the address 15 min |
| `POST /api/bootstrap/:token` | 10 per 60 s | 5 per 60 s | 60 s | address | same lock as the line above (one count for both) |
| `GET /api/invitations/:token` | 30 per 60 s | 10 per 60 s | 60 s | address | 10 refused tokens per address in 15 min lock the address 15 min |
| `POST /api/invitations/:token/accept` | 10 per 60 s | 10 per 60 s | 60 s | address | same lock as the line above (one count for both) |
| `GET /api/auth/oidc/:providerId/start` | 120 per 60 s (actor, else address) | 30 per 60 s | 60 s | address | none: no secret is guessed here |
| `GET /api/auth/oidc/callback` | 120 per 60 s (actor, else address) | 30 per 60 s | 60 s | address | the one-time `state` is single use and bound to the browser's cookie |
| `POST /api/auth/password/change` | 5 per 60 s | 5 per 60 s | 60 s | person | 5 wrong current passwords lock the change for that person 15 min |
| `POST /api/auth/email/verify-request` | 5 per 60 s | 5 per 60 s | 60 s | person | none |
| `POST /api/auth/sign-out` | none | 30 per 60 s | 60 s | person | none |
| `POST /api/auth/sign-out-everywhere` | none | 10 per 60 s | 60 s | person | none |
| `GET /api/auth/sessions` | none | 60 per 60 s | 60 s | person | none |
| `DELETE /api/auth/sessions/:id` | none | 30 per 60 s | 60 s | person | none |
| `POST /api/teams/:slug/invitations` | none | 30 per 60 s | 60 s | person | none |
| `POST /api/invitations` | none | 30 per 60 s | 60 s | person | none |
| `POST /api/teams/:slug/bots/:botSlug/pairing-tokens` | 10 per 60 s | 10 per 60 s | 60 s | person | none |
| `POST /api/teams/:slug/bots/:botSlug/pairing-tokens/rotate` | 10 per 60 s | 10 per 60 s | 60 s | person | none |
| `DELETE /api/teams/:slug/bots/:botSlug/pairing-tokens` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `POST /api/teams/:slug/runners/:runnerId/token` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `DELETE /api/teams/:slug/runners/:runnerId/token` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `POST /api/channels/:channelId/webhooks` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `POST /api/webhooks/:webhookId/rotate` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `DELETE /api/webhooks/:webhookId` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `POST /api/webhooks/:webhookId/signing-secret` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `DELETE /api/webhooks/:webhookId/signing-secret` | 30 per 60 s | 30 per 60 s | 60 s | person | none |
| `POST /api/teams/:slug/repo/app-token` | 120 per 60 s | 120 per 60 s | 60 s | person | none |
| `PUT /api/teams/:slug/projects/:projectId/push-credential` | 20 per 60 s | 20 per 60 s | 60 s | person | none |
| `POST /api/teams/:slug/hermes/connections` | 20 per 60 s | 20 per 60 s | 60 s | person | none |
| `POST /api/mcp/runs` | 60 per 60 s (wrong tokens not counted apart) | 60 per 60 s | 60 s | address | wrong pairing tokens count in the failures counter below |
| `POST /api/mcp/bots/:botId` | 60 failures per 60 s | 60 per 60 s | 60 s | failures | 61st wrong bot token in a minute and onward: `429` |
| `POST /mcp` | 60 failures per 60 s | 60 per 60 s | 60 s | failures | 61st wrong bot or run token in a minute and onward: `429` |
| `POST /api/llm/runs/:runId/v1/chat/completions` | 60 failures per 60 s | 60 per 60 s | 60 s | failures | 61st wrong run token in a minute and onward: `429` |
| `GET /api/runners/connect` | 60 per 60 s | 60 per 60 s | 60 s | address | none (the socket closes at once on a wrong runner token) |
| `POST /hooks/:webhookId/:secret` | 600 per 60 s (actor, else address) | 600 per 60 s | 60 s | address | 30 calls that name no live webhook or carry a wrong secret in 5 min lock the address 5 min (then failing calls get `429`; a call with the right secret is never refused by the lock, because senders share addresses) |

Also locked, though not a route in the table: `POST /api/test/session` (only mounted on a throwaway test server that sets
`MANYTHREADS_TEST_AUTH_TOKEN`): 10 wrong tokens per address in 15 min lock the address 15 min; a right token never counts.

Not on the list: `POST /api/slack-compat/chat.postMessage` (a spike plugin that is off unless `MANYTHREADS_SPIKE_SLACK_COMPAT=1`; it keeps its own 60 per 60 s limit).

Not credential routes, so not on the list: `GET /api/session` (reads who you are), `GET /api/auth/oidc/methods` (60 per 60 s), the
live socket `/ws` (it checks the session cookie it is given and grants nothing), and every ordinary read and write, which keep the
limits they declare.

## How a lockout behaves

- **Temporary.** Every lock lasts 15 minutes (the webhook lock 5) and expires by itself. A call made while a lock holds is refused
  without being counted, so it does not extend the lock: an attacker cannot keep a person out by hammering a locked account, only
  by waiting out each lock and failing again.
- **What the person sees.** `429` with the message "Too many failed attempts … Try again in N minutes." and a `retry-after`.
  The wording never says whether the email exists: unknown emails lock exactly like known ones.
- **A locked-out owner has ways back.** The reset link (`Email me a reset link`) is not blocked by the sign-in lock, and a completed
  reset lifts the account's lock; organisation sign-in (OIDC) is a separate route; and an operator can set a password with
  `pnpm --filter @manythreads/server admin set-password <email>`. Restarting the server also clears every lock.
- **Why two sign-in locks.** The email-and-address lock (5 failures) stops one machine guessing; the account lock (25 failures from
  any address) stops guesses spread over many addresses. The account lock is deliberately higher so one stranger cannot lock an
  owner out cheaply: it takes five different addresses, each locked in turn.
- **Audit.** Each failed password sign-in is already an audit event (`identity.session.sign_in_failed`, with the reason
  `wrong_password`, `suspended`, `method_disabled` or `locked`); see `docs/plugins/audit.md`.

## Adding a credential route

Add the route to `ABUSE_ROUTES` first, read its number with `abuseLimit(method, path)` in the route's `rateLimit`, set
`rateLimitBy: 'address'` when nobody is signed in, and add the line to the table above in the same change. Where a secret is
guessed, add the lockout (`createLockout` and `guardRedemption` from `@manythreads/sdk`). The tests walk the list, so a route
that is listed but not limited, or limited to another number, fails.
