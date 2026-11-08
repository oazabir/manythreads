# fake-saas

One process that stands in for every outside service of the connectors bundle (PLAN P16-12): Google, Microsoft 365 and Notion, Jira, Linear, GitHub Issues and
Asana, Zendesk, Intercom, HubSpot and Salesforce, the Telegram Bot API, and a sender of signed webhooks. Each answers over real HTTP sockets, like
`tools/fake-llm`, so the server under test reaches them the way it reaches the real ones. No real account is touched and every secret in here is made up.

It **refuses to start when `NODE_ENV=production`** (the library throws, the CLI exits 1). The server under test ignores the fake bases in production too.

The existing fakes stay in `packages/test-utils/src` (many tests import them); this package wraps them, starts them together, gives them one control port and
adds what was missing. Drive and Notion paging, OneDrive `delta`, calendar events that persist, and seeded sign-ins were added to `fake-providers.ts` for it.

## Run it

    pnpm -C tools/fake-saas start --host 0.0.0.0 --public-host 10.0.2.15 --port 18090 \
      --seed stage-seed --seed-grant google:nadia@kahf.example --seed-grant microsoft:rafi@kahf.example

It prints one line to wait for, `FAKE_SAAS {json}`: the control address, the address of each stand-in, the variables for the server under test (`env`), the
fake Telegram bot token and the seed key. With `--port 18090` the first stand-in (Google, Microsoft, Notion) takes 18090, the control port is 18091, then
trackers 18092, Zendesk 18093, Intercom 18094, HubSpot 18095, Salesforce 18096 and Telegram 18097. `--port 0` (the default) asks the OS for every port.

In a spec: `startFakeSaas(options)` from `tools/fake-saas/src/index.ts`, or `startOutsideSaas()` from `e2e/fixtures/outside.ts` (it adds the fake GitHub and returns
`env` for the server).

## Flags and environment variables of the CLI

| Flag | Variable | Default | Meaning |
|---|---|---|---|
| `--host` | `FAKE_SAAS_HOST` | `127.0.0.1` | Interface to bind. `0.0.0.0` for a stage release on another address. |
| `--port` | `FAKE_SAAS_PORT` | `0` | Base port (see above). |
| `--public-host` | `FAKE_SAAS_PUBLIC_HOST` | the host (127.0.0.1 for 0.0.0.0) | Host name written into the addresses handed out: what a pod or a browser must dial. |
| `--seed` | `FAKE_SAAS_SEED` | `manythreads-seed` | Key the seeded tokens are derived from. |
| `--seed-grant provider:address` (repeatable) | `FAKE_SAAS_SEED_GRANTS` (comma list) | none | Sign-ins that exist before any consent: `google`, `microsoft` or `notion`. |
| | `FAKE_SAAS_CONTROL_KEY` | none | When set, every control call must carry it in `x-fake-saas-key`. |
| | `FAKE_SAAS_CLIENT_ID`, `FAKE_SAAS_CLIENT_SECRET` | each fake's own | The app id and secret every OAuth stand-in accepts. |
| | `FAKE_SAAS_TELEGRAM_TOKEN`, `FAKE_SAAS_TELEGRAM_BOT_USERNAME` | a fixed fake token, `manythreads_fake_bot` | The bot the Telegram stand-in answers for. |
| | `NODE_ENV` | | `production` makes it exit 1. |

The variables it gives **to the server under test** (`env`, also printed): `MANYTHREADS_OAUTH_<P>_CLIENT_ID`, `..._CLIENT_SECRET` and `..._FAKE_BASE` for `P` in
GOOGLE, MICROSOFT, NOTION, JIRA, LINEAR, GITHUBISSUES, ASANA, ZENDESK, INTERCOM, HUBSPOT, SALESFORCE; `MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE` (the bridge dials
`<base>/bot<token>/<method>` instead of api.telegram.org); `FAKE_SAAS_CONTROL` (for a probe). `e2e/fixtures/outside.ts` adds `MANYTHREADS_TEST_GITHUB_API`.
Later stand-ins add `MANYTHREADS_BRIDGE_<P>_FAKE_BASE` and `MANYTHREADS_OAUTH_<P>_FAKE_BASE` the same way, through their module's `env()`.

## Seeded sign-ins

`seedToken(provider, seedKey, email)` is `fs_<provider>_<first 24 hex of sha256(seedKey + lowercase email)>`; `seedRefreshToken` is `fsr_<provider>_<...>` (Google and
Microsoft). A seeded stack seals these values, and the stand-in accepts them with no consent, with the scopes of `defaultScopes(provider)` (Drive read, Calendar
read and write, free/busy, mail read; the Microsoft equivalents). `saas.seedTokens(provider, email)` returns both.

## Control port (`/__fake/*`, JSON)

| Call | What it does |
|---|---|
| `GET /__fake/health` | `{ok:true}` |
| `GET /__fake/state` | What every stand-in saw: API calls (method, path, authorized), token calls, consents, writes (events, pages, mail, tracker and support writes), Telegram messages sent, webhooks the sender posted. **Never a token, code, verifier or client secret.** |
| `GET /__fake/env` | The variables for the server under test. |
| `POST /__fake/reset` | Forget everything recorded, put every account and tracker/support data back as at the start, clear forced failures and sign-ins made since (seeded ones stay). |
| `POST /__fake/send-webhook` | `{provider, url, secret, kind, tamper?, title?, ref?, actor?, now?, deliveryId?, body?, padBytes?}`: build, sign and POST; answers `{request, responses[]}` without the secret. |
| `POST /__fake/telegram/send` | `{fromUserId, chatId?, chatType?, chatTitle?, text, username?, firstName?, botToken?, updateId?, messageId?, secretHeader?: 'wrong'\|'missing', repeat?}`: POST an Update to the bot's webhook with `X-Telegram-Bot-Api-Secret-Token`, or queue it for `getUpdates` when no webhook is set. |
| `POST /__fake/telegram/fail-next` | `{status, count?, method?, retryAfter?}`: the next calls fail (429 carries `retry_after`). |
| `PATCH /__fake/accounts/:email` | `{files?, removeFiles?, trashFiles?, events?, pages?, mails?, shareCalendar?}`: upsert by id; files go in the Drive and OneDrive change feeds. `shareCalendar:false` makes the account's free/busy answer "not found". |
| `PUT /__fake/drive/:fileId/permissions` | `{account?, permissions:[{type:'anyone'}\|{type:'domain',domain}\|{type:'user'\|'group',email}]}`: who can open the file besides its owner. |
| `POST /__fake/sign-in-as` | `{email}`: the account the next consent signs in as. |
| `POST /__fake/deny-next-consent`, `/expire-tokens`, `/revoke-refresh-tokens` | The person says no; access tokens stop working; refresh tokens are refused. |
| `POST /__fake/fail-next` | `{service:'workspace'\|'trackers'\|'support', status, count?}`. |
| `* /__fake/<module>/...` | A module's own actions (Telegram's two above are `<module>` = `telegram`). |

In code the same things are `saas.control.sendWebhook(...)`, `saas.control.telegramSend(...)`, `saas.control.state()`, `saas.control.reset()`, and the typed
objects `saas.workspace` (`FakeProviders`), `saas.trackers`, `saas.support`, `saas.telegram`.

## Signed webhooks: what the sender signs

`tamper`: `none`, `signature` (signed with another secret), `body` (changed after signing), `unsigned` (no proof), `stale` (correctly signed but old), `replay` (the same
call twice, same delivery id). `padBytes` makes an oversized body; `body` signs exactly the text given (a provider's published vector).

| Provider | Proof | Time | Delivery id | Kinds |
|---|---|---|---|---|
| github | `X-Hub-Signature-256: sha256=` hex HMAC-SHA256(secret, body) | none; stale = event 8 days old | `X-GitHub-Delivery` | issue.created, issue.updated, issue.closed, comment.created, pull_request.opened, pull_request.closed, push |
| gitlab | `X-Gitlab-Token: <secret>` | none; stale = event 8 days old | `X-Gitlab-Event-UUID`, `Idempotency-Key` | issue.created, issue.updated, merge_request.opened, push |
| jira | `X-Hub-Signature: sha256=` hex HMAC-SHA256(secret, body) | none; stale = event 8 days old | `X-Atlassian-Webhook-Identifier` | issue.created, issue.updated, comment.created |
| linear | `Linear-Signature:` hex HMAC-SHA256(secret, body) | body `webhookTimestamp` (ms); stale = 10 min | `Linear-Delivery` | issue.created, issue.updated, comment.created |
| zendesk | `X-Zendesk-Webhook-Signature:` base64 HMAC-SHA256(secret, timestamp + body) | `X-Zendesk-Webhook-Signature-Timestamp` (ISO 8601); stale = 10 min | `X-Zendesk-Webhook-Invocation-Id`, body `id` | ticket.created, ticket.status_changed, ticket.comment_added |
| intercom | `X-Hub-Signature: sha1=` hex HMAC-SHA1(client secret, body) | none; stale = event 8 days old | body `id` (`notif_...`) | conversation.created, conversation.replied, contact.created |
| hubspot | `X-HubSpot-Signature-v3:` base64 HMAC-SHA256(client secret, `POST` + url + body + timestamp) | `X-HubSpot-Request-Timestamp` (ms); stale = 10 min | body `eventId` | contact.created, ticket.created, deal.created |
| asana | handshake: `X-Hook-Secret` (the receiver echoes it); then `X-Hook-Signature:` hex HMAC-SHA256(hook secret, body) | none; stale = event 8 days old | none | handshake, task.created, task.changed |
| generic | `X-Manythreads-Signature: v0=` hex HMAC-SHA256(secret, `v0:` + timestamp + `:` + body) | `X-Manythreads-Request-Timestamp` (s); stale = 10 min | body `id` | any kind name |

The tests check each scheme against a reference written in the test from the provider's documentation, and GitHub's and Slack's published vectors.

## Telegram stand-in

`/bot<token>/{getMe,setWebhook,deleteWebhook,getWebhookInfo,getUpdates,sendMessage}` in Telegram's envelope. A wrong token is 401; `setWebhook` keeps the url and
`secret_token` (1-256 of `A-Za-z0-9_-`) and never shows the secret; `getUpdates` is 409 while a webhook is set; `sendMessage` needs a chat and 1-4096 characters,
and with `strictChats` only answers chats that wrote first (403). `failNext` forces errors, including 429 with `retry_after`.

## What each stand-in does beyond the wrapped fakes

- Google: Drive `files.list` by parent and type, paging, `permissions.list`, `changes` with start token and paging, calendar create/get/patch/delete that persist
  (description and location kept), free/busy that honours `shareCalendar:false`.
- Microsoft: `children`, `permissions` (anonymous and organization links, users, groups), `root/delta` with `nextLink` and `deltaLink`, events create/get/cancel/delete,
  `getSchedule` that honours `shareCalendar:false`.
- Notion: `search` sorted by `last_edited_time`, paged; `blocks/children` paged; archived pages hidden; `public_url` on public pages.
- Limit, said plainly: Microsoft does not name the tenant of an organization link, so a domain share to another domain than the owner's has no counterpart there.

## Adding a stand-in

Write `src/providers/<name>.ts` exporting a `StandInModule` (`id`, optional `ports`, `start(context)` returning `{api, urls, env(), state(), reset(), control?, stop()}`),
then **append** one import and one line to `src/providers/registry.ts`. Its `env()` is merged into the server's variables, its `state()` into `/__fake/state`, its
`reset()` into `/__fake/reset`, and `control(request)` answers `/__fake/<id>/...`. Nothing else changes.
