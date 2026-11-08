# webhooks

Incoming webhooks for channels (PLAN P14-14). A channel's lead (or a workspace admin) makes a secret web address for the channel. A build server, GitHub, GitLab, an alert manager or any script that sends a message to that address makes it appear in the channel, written by the webhook's own name with a **Webhook** mark, never as a person. How a team uses it: [deploy/ci-to-channel.md](../deploy/ci-to-channel.md).

Package: `packages/plugins/webhooks`. Manifest: `extends: ['event.emit', 'event.subscribe', 'job.register', 'hook.pre_egress', 'secret.seal']`, `dependsOn: ['channels', 'bots', 'teams', 'guardrails-egress', 'guardrails-dlp']`, consumes `channel.message.posted`, emits the five `webhooks.hook.*` events and `webhooks.token.changed`, `webhooks.token.used`, `webhooks.outgoing.changed`, `webhooks.outgoing.delivered` (see "Integrations" below for tokens and outgoing webhooks). Schemas: `packages/shared/src/{api/webhooks,events/webhooks.hook.*.ts}`. A word on jargon: a **webhook** is an address a program calls to tell another program something happened; a **signature** is a short code the sender computes from the message and a shared secret, so the receiver can tell the message was not forged.

## Routes

| Route | Who | What |
|---|---|---|
| `POST /hooks/:webhookId/:secret` | anyone holding the address | The public door. Posts the message. `200 {ok, messageId}`; `200 {ok, ignored}` for an event the webhook does not show; `400` unreadable body; `401` not signed (only when a signing secret is set); `404` unknown, wrong, rotated or switched-off address (all identical); `409` the channel is archived; `413` over 1 MB; `429` over 120 calls a minute (`Retry-After` says when). |
| `GET /api/channels/:channelId/webhooks` | lead of the channel's team, workspace admin | The channel's live webhooks and the address prefix. Never a secret. |
| `POST /api/channels/:channelId/webhooks` | same | Makes one (`{name, emoji?}`), answers `201` with the full address. This is the only time the address is shown. |
| `POST /api/webhooks/:id/rotate` | same | A new secret; the old address stops working at once. Answers the new address once. |
| `DELETE /api/webhooks/:id` | same | Switches it off for good (the row stays for the audit; its past messages keep their author name). |
| `POST` / `DELETE /api/webhooks/:id/signing-secret` | same | Makes (shown once) or removes the signing secret. |
| `POST /api/webhooks/:id/test` | same | Posts a short test message through the same path a real call takes. |

The web screen is the **Integrations** button in the header of a channel (shown to leads and admins; not in direct messages); its first tab is these incoming webhooks. The answer of the public door also carries `skippedBlocks` (Block Kit blocks that were left out).

## How a call is handled

1. The address shape is checked (`/hooks/<uuid>/mtwh_<43 characters>`); anything else is a plain `404`.
2. The webhook is found by its id and the secret is compared, as a SHA-256 hash, with `timingSafeEqual`. One comparison is done whether or not the webhook exists, so the time says nothing. An unknown id, a wrong secret, a rotated secret and a switched-off webhook all give the same `404` with the same body.
3. The webhook's own rate limit (a sliding window in process memory, 120 a minute; `MANYTHREADS_WEBHOOK_RATE_PER_MINUTE` changes it) and a coarse limit per address run next. The body is read up to 1 MB (`413` beyond).
4. When the webhook has a signing secret, the call must carry a valid GitHub `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) or a matching GitLab `X-Gitlab-Token`; otherwise `401`. Signature checks are constant-time.
5. A payload reader turns the body into Markdown (below). The message is posted through the channels plugin's own `messages` provider, as the webhook's actor, so search, unread, notifications (P14-09), retention and row-level security treat it like any message.

Refused calls write at most one `webhooks.hook.use_failed` audit line per webhook and reason per minute (a flood of bad calls cannot flood the log). Nothing a caller sends is ever echoed back with a secret in it.

## Payload readers (`src/adapters`)

Pure functions, the same input always gives the same Markdown, covered by `test/adapters.test.ts`.

| Sender | How it is recognised | What is shown |
|---|---|---|
| GitHub | `X-GitHub-Event` header | push, pull request (opened, reopened, ready for review, merged, closed, review requested), review, issues (opened, closed, reopened), workflow run and check run when finished, release published. `ping` and every other event: `200` with `ignored`. |
| GitLab | `X-Gitlab-Event` header | push, merge request, pipeline, issue |
| Alertmanager | its fixed JSON shape | one message per notification: firing or resolved, labels, summary, links |
| Sentry | `Sentry-Hook-Resource` header or its JSON shape | the issue title, level, project and link |
| Generic JSON | `{text, title?, url?, status? / color?, fields?[]}` | the text, a bold linked title, a status mark, a list of fields |
| Slack and Mattermost | `{text, attachments, blocks}` (also `payload=` as a form) | the same, with Slack links and bold converted; a small subset of blocks |
| Plain text | any other body | the text as it is |
| JSON with nothing readable | | shown as received in a code block, so a call is never silently lost |

Text from outside is treated as untrusted. Raw HTML and control characters are removed, an `@` that would name a person or the channel is broken so nobody is pinged, links must be `http` or `https` without a password in them, titles and fields are escaped and cut to a fixed length, long text is cut at 8,000 characters, and everything runs in linear time (the tests feed 1 MB of hostile input). The result goes through the same Markdown repair as a bot's message (file names in code spans, open code blocks closed).

## Data

Migrations `migrations/0001_webhooks.sql` and `0002_message_authors_system.sql` (the second lets the system role name the authors of the messages it asks about, so the live push of a webhook's message carries the webhook as author instead of "Someone"):

- `app.webhooks`: the visible row (channel, name, emoji, who made it, last use, counters). Row-level security: a lead of the channel's team or a workspace admin reads it (`readable_team_ids('manage')`); only the system role writes.
- `app.webhook_secrets`: the SHA-256 of the secret and the id of the sealed signing secret (`app.secrets`). System only; no request role has any access.
- Each webhook gets its own actor (kind `system`, `ref_id` = the webhook id), which becomes the author of its messages. `app.message_authors` is replaced so that such an author is named by the webhook's name (with its emoji in front), and the notifications plugin names it the same way.
- Definer functions `app.webhooks_create`, `_rotate`, `_revoke` check that the caller is a person who may manage the channel; `app.webhooks_act_as` switches a system transaction to the webhook's actor for the duration of one post and answers only to the system role.

The secret is `mtwh_` followed by 256 random bits; it is never stored, logged, audited or put in an error. The server's request log writes the address with the secret part replaced (`/hooks/<id>/[redacted]`, `packages/server/src/log-redact.ts`), and the web pod's nginx writes no access log line for `/hooks/` at all; a proxy in front of the site (the ingress, Cloudflare) keeps its own access log, so do not enable full-URL logging there. The signing secret (`mtws_...`) has to be readable to check signatures, so it is sealed with the platform's secret store.

## Integrations: API tokens and outgoing webhooks

The plugin holds three kinds of **integration**, all rows of `app.webhooks` (column `kind`: `incoming`, `api`, `outgoing`). Each has its own system-kind actor, so its messages are written by its name with the **Webhook** mark, and a channel holds at most 20 of them together. Why here and not in `slack-compat`: the identity of an integration (its own author, the secret hash, act-as, the Webhook mark) already lives in this plugin, plugins cannot import each other, and `slack-compat` is a spike that writes `app.messages` directly for the Hermes runtime. The spike is unchanged; the product API is below and lives at `/api/slack/...`.

The screen is the **Integrations** button in a channel's header (leads and workspace admins): one dialog with three tabs, *Incoming webhooks*, *Outgoing webhooks* and *API tokens*. Each lists, makes, tests, pauses or switches off, and shows a secret only once.

### API tokens (the Slack-shaped Web API)

A token is `mtat_` and 256 random bits. It is shown once; only its SHA-256 is stored (`app.webhook_secrets`, indexed, looked up by that hash and re-checked in constant time). A token reaches the channel it was made in and, if the lead picked them, other channels of the same team (at most 10), and only the methods the lead ticked. `rotate` makes a new token and the old one stops at once; `revoke` deletes the hash. A revoked, rotated or unknown token all answer `invalid_auth`, so nothing tells which.

| Route | What |
|---|---|
| `POST /api/slack/chat.postMessage` | `channel` (id or `#name`), `text` and/or `blocks` / `attachments` (JSON or a JSON string), `thread_ts`. Answers `{ok, channel, ts, message}`; `skipped_blocks` counts blocks that are not shown. |
| `POST /api/slack/chat.update` | `channel`, `ts`, `text` (or blocks). Only a message this same token posted; the old text is kept as an edit version like any edit. |
| `POST /api/slack/reactions.add` / `.remove` | `channel`, `timestamp`, `name` (a Slack name such as `thumbsup`, or a custom emoji of the workspace). |
| `POST` / `GET /api/slack/auth.test` | `{ok, user, user_id, bot_id, url, team, channels}` |
| `GET` / `POST /api/channels/:id/api-tokens`, `POST /api/api-tokens/:id/rotate`, `DELETE /api/api-tokens/:id`, `POST /api/api-tokens/:id/test` | The lead's side: list, make (`{name, emoji?, methods?, moreChannelIds?}`, secret shown once), rotate, switch off, send a test message. |

The body is JSON or form-encoded like Slack's; the token goes in `Authorization: Bearer <token>` (or a `token` field in the body or form; never in the query string, which would reach access logs, and a `?token=` is ignored). Answers are `200 {"ok": true, ...}` or `200 {"ok": false, "error": "..."}` so existing scripts work. The words: `not_authed`, `invalid_auth`, `missing_scope` (with `needed` and `provided`), `channel_not_found`, `not_in_channel` (a channel the token was not given, the same word whether or not it exists), `is_archived`, `no_text`, `msg_too_long` (over 40,000 characters), `message_not_found`, `cant_update_message`, `thread_not_found`, `invalid_name`, `already_reacted`, `no_reaction`, `invalid_json`, `invalid_form_data`, `invalid_blocks`, `invalid_attachments`, `invalid_arguments`.

**Rate limit: the one place that differs from "always 200".** `rate_limited` is answered as Slack itself does, `429` with a `Retry-After` header and the body `{"ok": false, "error": "rate_limited"}`, because Slack client libraries retry on a 429 and ignore the header on a 200. Each token has 60 calls a minute (`MANYTHREADS_API_TOKEN_RATE_PER_MINUTE`), and no per-address counter for good calls. An address that presents 30 unknown tokens in 5 minutes is locked for 5 minutes for failing calls only; a call with a right token is never refused by the lock. Limits are in process memory (PLAN D3). A body over 1 MB is answered `413`, as Slack does.

**`ts` is the message id.** A message id is a UUIDv7 (48 bits of milliseconds, then a 12-bit sub-millisecond fraction). `ts` is `"<seconds>.<six digits>"` where the six digits are the milliseconds of the second times 1000 plus the sub-millisecond fraction scaled to 0-999 (`src/ts.ts`). It is deterministic, sorts like time, and is turned back into an id by searching the id range of that microsecond. Two limits, both stated in the code: two messages created in the same microsecond share a `ts` (the lookup then prefers the message the integration wrote itself), and a script must send back the `ts` it was given.

Text from a token is untrusted like a webhook's: Block Kit and mrkdwn are converted (below), `@name`, `@here`, `@channel` and `<@U123>` are kept as plain words that notify nobody (messages are posted with `skipRefs`), raw HTML is removed.

Every call of a known token writes one `webhooks.token.used` event (method, outcome, status; no text, no token) and updates the token's counters; making, rotating and switching off write `webhooks.token.changed`. Both are mapped in the audit plugin and carry no secret or message text.

### Block Kit, attachments and Mattermost (incoming webhooks and `chat.postMessage`)

`src/adapters/slack.ts`. Shown: `header`, `section` (text, fields, an accessory image or button with an address, as a link), `divider`, `context`, `image` (as a link), `actions` (buttons that have an address, as links only). Every other block, or a block with nothing to show, is **skipped and counted** (`skippedBlocks` in the incoming webhook's answer, `skipped_blocks` in the API's), never an error; at most 50 blocks are read. Attachments: `pretext`, `title` (linked with `title_link`), `text`, `fields`, `color` (as a mark), `footer`; Slack's `fallback` is used only when there is nothing else. mrkdwn: `*bold*` and `~strike~` are converted, `<url|label>` is a link (the address must be `http` or `https` with no password; the label cannot close the link), `&lt; &gt; &amp;` are unescaped. All of it is linear in time; the tests feed 1 MB of hostile text.

### Outgoing webhooks

A lead sets, for one channel, up to 10 **trigger words** (matched whole-word, capitals ignored; `starts` means the message begins with one, `contains` anywhere; in `contains` mode a word needs at least 3 characters, since a one- or two-letter word would send nearly every message out) and an address, and may add a signing secret (`mtos_`, sealed with the secret store). When a **person's** message matches, a background job (`webhooks.outgoing`, `detached`: no database transaction while the receiver is waited for) sends a JSON call shaped like Slack's outgoing webhook:

`{token, team_id, team_domain, channel_id, channel_name, timestamp, user_id, user_name, text, trigger_word, message_id, thread_ts?, truncated?}`

`token` is the hook's verification token (not a secret). With a signing secret the headers `X-Manythreads-Request-Timestamp` and `X-Manythreads-Signature: v0=HMAC-SHA256("v0:<timestamp>:<body>")` are added (the same idea as Slack's); the screen shows a short Node check.

- **The fetch** is the shared SSRF-safe one (`@manythreads/sdk/safe-fetch`, moved there from link-preview with POST support): the name is resolved once and the vetted public address is the one dialled (DNS rebinding cannot swap it), private, loopback, link-local and mapped addresses are refused, ports 80 and 443 only, 5 seconds in all, the answer read up to 64 KB, at most 2 redirects and only 307/308 for a POST (the same body again, each target vetted again). A POST is repeated only at the **same host**, and never from https to http, because its headers may hold a signature and the data-loss check ran for the first host only; a hook whose address moved to another host answers `bad_redirect` and the lead sets the new address. The workspace's `pre_egress` guard (air-gapped or strict presets, the team's host list, the data-loss check which can redact or refuse the text) judges the destination at every hop and the text once, and fails closed.
- **The reply.** A 2xx answer with `{"text": "..."}` (also `blocks`, `attachments`) is posted back as the integration, once, in the same transaction that marks the delivery done, in the thread if the trigger was in one (or under the message with `response_type: "comment"`). `response_type: "ephemeral"` posts nothing. Mentions in the reply notify nobody.
- **Loop guard.** Only a person's message triggers a hook; the reply is written by the integration's system actor, so it can never trigger this or another hook, however many times it says the trigger word.
- **Retries and the dead letter.** A hook with a signing secret is never sent unsigned: when the secret cannot be read the try fails as `internal_error` and is tried again later. Delivery is at least once (the call carries `message_id`). A timeout, a dropped connection, 408/425/429 and 5xx are tried again up to 5 times with the queue's backoff, then the delivery is **dead**; a blocked address, a refusal by the workspace rules, and any other 4xx are dead at once. `app.webhook_deliveries` (system only) is the once-only guard and the record, kept 14 days; the lead sees the last result and the counts on the screen, and `webhooks.outgoing.delivered` (outcome `delivered`, `retry` or `dead`, status code, a short reason, no text) goes to the audit trail.
- **Limits.** At most 60 messages a minute per hook (more are dropped; one dead-letter line a minute says so).
- **Private channels and DMs.** Only a lead or admin of the channel's team can make a hook, and only one who can **read the channel themselves** (a lead who is not a member of a private channel is refused with a sentence, in `app.integrations_create`; the routes that turn a hook on, change its address, words or matching, or set its signing secret check the same, while switching it off is always allowed). A hook sends only messages of its own channel. There are no hooks in direct messages.
- Routes: `GET` / `POST /api/channels/:id/outgoing-hooks`, `PATCH` / `DELETE /api/outgoing-hooks/:id`, `POST` / `DELETE /api/outgoing-hooks/:id/signing-secret`, `POST /api/outgoing-hooks/:id/test` (sends one sample call now and reports the answer; nothing is posted in the channel).
- For browser specs, with `NODE_ENV=test` and `MANYTHREADS_STACK_WEBHOOK_RECEIVER=<port>` the names `*.fake.example` resolve to a public number that is connected to `127.0.0.1:<port>` (`testReceiverDeps`); every other rule still runs.

### Data added by migration `0003_integrations.sql`

`app.webhooks` gets `kind` and `call_count`; new tables `webhook_api` (the methods of a token), `webhook_channels` (the channels of a token, position 0 is its home), `webhook_outgoing` (address, trigger words, match, verification token, sealed signing secret id, counters, last delivery) and `webhook_deliveries` (system only). A team's leads and workspace admins can read the first three; every write is the system role or the definer function `app.integrations_create` (which checks that the caller manages the channel and every extra channel). `app.webhooks_rotate` and `_revoke` serve all kinds.

## Rules to keep

- A webhook can only post into the channel it was made for and only as itself. Do not give it any other power.
- The same `404` for every bad address. Do not add a reason to the answer.
- New sender shapes go in `src/adapters` as pure functions with a test, and use `inline()`, `quote()`, `safeUrl()` for anything the sender wrote.
- Rate limits stay in process memory (PLAN D3).

## Bundle D contracts (P16-10, work apps calling in)

`webhooks/0004_provider_endpoints.sql` adds the kind `provider` to `app.webhooks`, the tables `webhook_provider` (one address per channel and service, the signing secret sealed), `webhook_provider_events` (what came
in: service, kind, a hash and an id; the body is not kept) and `webhook_provider_runs` (which delivery woke which bot run), the functions `app.integrations_create_provider`, `app.webhooks_claim_run` (system-only; a
delivery wakes a bot once) and `app.webhooks_run_origin`. Services: `WebhookProvider` = `github`, `gitlab`, `jira`, `linear`, `zendesk`, `intercom`, `hubspot`, `asana`, `generic`.

Door: `POST /hooks/apps/:endpointId` is public, `csrfExempt`, `rawBody`, rate limited by address; it believes only a valid signature (and a fresh timestamp and a new delivery id where the service sends them). The
`ProviderReader` in `providers/index.ts` turns a request into a short plain event (a kind and a few sentences, never the whole payload). Admin routes: `GET|POST /api/channels/:channelId/provider-hooks`,
`PATCH|DELETE /api/provider-hooks/:endpointId`, `PUT /api/provider-hooks/:endpointId/signing-secret`, `POST /api/provider-hooks/:endpointId/rotate`, `GET /api/runs/:runId/origin`, `GET
/api/admin/webhooks/provider-health`. Events: `webhooks.provider_endpoint.changed`, `webhooks.provider_event.received` and `webhooks.provider_event.refused` (at most one per minute per endpoint and reason). The log
redactor keeps `/hooks/apps/<id>` and `/hooks/bridges/<service>/<id>` readable and still hides the old `/hooks/<secret>/…`. Work package H filled `providers/`, `routes-provider.ts`, `provider-door.ts`, `origin.ts` and
the `runtime-hermes` `router-webhook.ts`.

## Work apps calling in (P16-10, built)

What a lead does: at a channel's Integrations screen, tab **Work apps**, make an address for GitHub, GitLab, Jira, Linear, Zendesk, Intercom, HubSpot, Asana or any sender that signs its calls
(`generic`). The address is `https://<site>/hooks/apps/<id>` and holds no secret; the app proves each call with a signature. GitHub, GitLab, Jira, Linear and `generic` get a signing secret made here,
shown once (and again only through "New signing secret", which retires the old one at once). Zendesk, Intercom and HubSpot have their own secret: the lead pastes it (at make time or later). Asana makes
its own when the address is connected (its handshake). A bot starts from an event when its BOT.md has `- type: webhook` with `connection:` equal to the address's **short name** (`slug`) and, if wanted, `event:`
(`ticket.created`, or `ticket.*`). A `webhook` trigger with no `connection` matches no address. The shipped Support responder lists `connection: zendesk`, `event: ticket.created`: a lead makes an address
called `zendesk` in #support and it works.

### The door, in order (`provider-door.ts`)

1. The address must be an id. An unknown, revoked or switched-off address all answer the same `404` (30 such calls in 5 minutes from one client address lock that address for 5 minutes: `429`).
2. 120 calls a minute per address (`429`), then the body, at most 1 MB (`413`, read as a stream, so a larger body is never held).
3. Asana's first call carries `X-Hook-Secret`: it is echoed, sealed, and kept once (a later one is not a handshake).
4. The signature is checked over the **raw bytes** with the sealed secret, in time that does not depend on where the first wrong byte is. A bad one answers `401` and changes nothing. Nothing is read from the body first.
5. Only then is the body parsed as JSON (`400` if it is not), checked for age where the app sends no timestamp inside its signature, turned into a kind, title, link and actor, and passed through the address's event
   filter (`202`, forgotten, for an event the platform does not use or the filter leaves out).
6. One transaction stores it and announces it (`200`; `{ "duplicate": true }` for a repeat). The answer never waits for a model.

| App | Header(s) | What is signed | Replay window |
| --- | --- | --- | --- |
| GitHub | `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 of the body | event time within 7 days |
| GitLab | `X-Gitlab-Token` | the token itself (it does not cover the body) | event time within 7 days |
| Jira | `X-Hub-Signature: sha256=<hex>` | HMAC-SHA256 of the body | event time within 7 days |
| Linear | `Linear-Signature: <hex>` | HMAC-SHA256 of the body; body field `webhookTimestamp` | 60 seconds |
| Zendesk | `X-Zendesk-Webhook-Signature` and `-Timestamp` | base64 HMAC-SHA256 of timestamp + body | 5 minutes |
| Intercom | `X-Hub-Signature: sha1=<hex>` | HMAC-SHA1 of the body | event time within 7 days |
| HubSpot (v3) | `X-HubSpot-Signature-v3` and `X-HubSpot-Request-Timestamp` | base64 HMAC-SHA256 of `POST` + the public address + body + timestamp | 5 minutes |
| Asana | `X-Hook-Signature` | HMAC-SHA256 of the body (after the handshake) | event time within 7 days |
| generic | `X-Manythreads-Signature: v0=<hex>` and `X-Manythreads-Request-Timestamp` (seconds) | HMAC-SHA256 of `v0:<timestamp>:<body>` | 5 minutes |

HubSpot signs the address it was given, so the door rebuilds it from the site's public URL (`publicUrl`): if that is wrong, every HubSpot call fails with `401`. GitLab's token does not cover the body, so a body
changed in flight is not noticed for GitLab (the app offers nothing stronger).

### Dedupe

A delivery is the same one when its delivery key (the app's own delivery id, or the body's sha256 when it sends none) was seen on that address in the last 7 days. Because a delivery id in a header is not
covered by the signature, the **body's sha256** is checked too: a signed body replayed under a new id is still a repeat. One good delivery is exactly one stored event and one `webhooks.provider_event.received`.

### From event to run (`runtime-hermes/src/router-webhook.ts`)

`webhooks.provider_event.received` (ids and the kind only) is read again from its rows. Every active bot of the address's team with a matching `webhook` trigger gets one run: no asker (the bot's own rights),
the prompt is the platform's facts plus the app's title, link, actor and trimmed payload inside one fenced "outside data" block (`buildWebhookPrompt`, text that cannot close the fence), and the post lands at the top
of the channel with `meta.runId`. A latch row in `outbox_processed` (per bot) stops a redelivered announcement; the run itself claims `app.webhooks_claim_run(event, bot, run)` as soon as it is open, so a
replayed job stops there. A bot that may not post in the channel gets no run (`no_channel`), and a bot is capped at 30 webhook runs an hour (`bot_busy`); each is told to the lead once a minute with a count in
`webhooks.provider_event.refused`.

### "What started this run"

`GET /api/runs/:runId/origin` answers `webhooks_run_origin`: the app, the address's name, the kind, title, link, who did it and when it arrived. Anyone who cannot read the channel, and any run that no app started,
gets `404`. The web card under the bot's top-level post is closed by default ("What started this run · Zendesk · <title>"), opens to the details, closes with Esc, and links only to http or https addresses.

### Deviations from the contract, on purpose

- `webhook_provider_events` keeps the **trimmed payload** (under 48 KB, no `__proto__`, `constructor` or `prototype` keys) next to the hash, not only the hash: the run's prompt and the card are read from it. Events are
  kept **30 days** (an hourly purge job), longer than the 7-day dedupe window, so the card under an old post still opens. The signing secret itself is never stored in the row, only sealed.
- `ProviderReader` has two methods more than the stub: `deliveryKey` and an optional `eventTime`.
- Migration `0005_provider_make_by_system.sql` lets `app.integrations_create_provider` be called from a system transaction (the route seals the secret in the same step), leaving `created_by` for the route to fill.
- A name is at most 60 characters here (the contract allows 80). The route's health view (`GET /api/admin/webhooks/provider-health`) lives in `routes-provider.ts`.

### Proved against the stand-in only

Every signature scheme is tested against `tools/fake-saas` (which signs the way each app's documentation says) and, for GitHub, against the documented test vector. No real GitHub, Zendesk, Jira, Linear,
Intercom, HubSpot or Asana has called this code yet; the first real call of each is the live check.
