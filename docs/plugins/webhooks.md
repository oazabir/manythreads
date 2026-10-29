# webhooks

Incoming webhooks for channels (PLAN P14-14). A channel's lead (or a workspace admin) makes a secret web address for the channel. A build server, GitHub, GitLab, an alert manager or any script that sends a message to that address makes it appear in the channel, written by the webhook's own name with a **Webhook** mark, never as a person. How a team uses it: [deploy/ci-to-channel.md](../deploy/ci-to-channel.md).

Package: `packages/plugins/webhooks`. Manifest: `extends: ['event.emit', 'secret.seal']`, `dependsOn: ['channels', 'bots', 'teams']`, emits the five `webhooks.hook.*` events. Schemas: `packages/shared/src/{api/webhooks,events/webhooks.hook.*.ts}`. A word on jargon: a **webhook** is an address a program calls to tell another program something happened; a **signature** is a short code the sender computes from the message and a shared secret, so the receiver can tell the message was not forged.

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

The web screen is the **Webhooks** button in the header of a channel (shown to leads and admins; not in direct messages).

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

## Left for later

PLAN row P14-14 also lists the Slack-shaped `chat.postMessage` / `chat.update` / `reactions.add` API and outgoing webhooks on a keyword. They are not part of this plugin yet; the `slack-compat` spike is unchanged.

## Rules to keep

- A webhook can only post into the channel it was made for and only as itself. Do not give it any other power.
- The same `404` for every bad address. Do not add a reason to the answer.
- New sender shapes go in `src/adapters` as pure functions with a test, and use `inline()`, `quote()`, `safeUrl()` for anything the sender wrote.
- Rate limits stay in process memory (PLAN D3).
