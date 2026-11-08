# Plugin: bridges (chat apps)

Telegram, WhatsApp, Slack and Microsoft Teams joined to manythreads (PLAN Bundle D, P16-09). Status: all four services are built: the core, identity, Telegram, WhatsApp and the web pages (work package B1), then Slack and
Teams (`adapters/slack.ts`, `adapters/teams.ts`, `adapters/jwt.ts`, work package B2).

## What a person sees

An admin connects one account per service at Settings > Chat apps (a switch, the credentials, health). A person proves a chat user is theirs with a short code (Account > Chat apps) and is then heard: a direct
chat with the bot talks to the person's Personal bot, and a public channel joined to an outside chat shows the words posted as that person with "via Telegram" (the key `Message.meta.via`, one of
`telegram`, `whatsapp`, `slack`, `teams`). Only linked people are heard; anyone else gets one plain sentence saying how to link. What the channel says goes back to the outside chat.

## Data (`bridges/0001_bridges.sql`)

`bridge_accounts` (one per workspace and service; status `off`, `on`, `attention`), `bridge_secrets` (sealed; names `bot_token`, `app_secret`, `signing_secret`, `inbound_secret`; never read back by a route),
`bridge_identities` (a chat user linked to a person), `bridge_link_codes` (purpose `identity` or `channel`, short-lived, a few per hour), `bridge_links` (a public channel joined to an outside chat),
`bridge_dm_sessions`, `bridge_messages` (direction `in`/`out`, status `received`, `pending`, `waiting` for WhatsApp's closed 24-hour window, `sent`, `dead`; ids only, no text) and
`bridge_unlinked_chats` (counts of strangers, for the one-sentence reply). The secret and message tables are system-only; people read their own identity rows, admins read the accounts.

## Routes (shared `api/bridges/index.ts`)

Admin: `GET /api/admin/bridges`, `PUT|DELETE /api/admin/bridges/:provider`, `PUT /api/admin/bridges/:provider/credentials`, `POST /api/admin/bridges/:provider/switch`, `GET /api/admin/bridges/health`. Person: `GET /api/me/bridges`, `POST /api/me/bridges/:provider/link-code`,
`DELETE /api/me/bridges/:provider`. Channel: `GET /api/channels/:channelId/bridge-links`, `POST /api/channels/:channelId/bridge-links/:provider/code`, `DELETE /api/bridge-links/:linkId`. Public doors: `GET|POST /hooks/bridges/:provider/:accountId`
(challenge and inbound; a valid signature is the only credential; rate limited by address). Events (ids and counts): `bridges.account.changed`, `bridges.channel.linked|unlinked`,
`bridges.identity.linked|unlinked`, `bridges.message.refused`.

## How it works

**Inbound** (`inbound.ts`). The chat service POSTs to `/hooks/bridges/<provider>/<accountId>` (the address is shown on the admin page; Telegram is told it by `setWebhook`, WhatsApp is given it by hand in the Meta console).
Order: find the account (unknown or off is the same 404) -> read at most 1 MB of the raw body -> `adapter.verify` (a bad secret or signature is 401, nothing stored, at most one `bridges.message.refused` event a minute) ->
parse -> per message: **classify** in one system transaction, **act**.

- A sender who is **not linked** is dropped before anything is stored: no `app.messages` row, no run, no model call. Only counters change (`bridge_unlinked_chats`, `bridge_accounts.dropped_count`), and the "link your account first" reply
  is sent at most once an hour per chat. A stranger's text is never kept. An unlinked group that is not joined to a channel is ignored without a reply.
- A **replayed** update id is ignored: the id is claimed in `bridge_messages (account, provider_update_id)` before anything happens, and the claim is undone if the system itself failed, so the service's retry is handled.
- **Commands**: `/start <code>` and a bare 8-digit code in a private chat link the chat user to the person who asked for the code; `/connect <code>` in a group joins that group to the channel the code was made for; `/unlink` and `/bot [name]`
  (choose which bot the private chat talks to) are private only. Five wrong codes from one chat in 15 minutes lock it for 15 minutes (identity and channel codes share the count). A code works once, for 10 minutes, and is stored as a hash.
- A **linked person's message in a joined group** is posted to the channel as that person with `meta.via = {provider}` (so a bot mention in it starts a run with that person as the asker). In a **private chat** it is posted as the person in their
  conversation with a bot (`app.conversations_open`), continuing the thread if the last message is under an hour old.
- Everything inbound is hostile text (`text.ts`): control, direction and zero-width characters out, `@channel`/`@here`/`@everyone` defused, at most 4000 characters, no markup is added on the way out.

**Outbound** (`outbound.ts`). A `channel.message.posted` consumer queues `bridges.fanout` only when the channel has a link or a DM session. The job sends to every link of a public, live channel (all messages) and to every DM session of a conversation
channel (bot messages only). A message that itself came in over a bridge (`meta.via`) is not sent back to the chat it came from. Each send is its own `bridges.send` job (retries up to 3 times, rate-limit aware), the text passes the `pre_egress` hook
chain (destination `bridge`; a blocked or unreachable chain fails closed), and the call goes through the one outbound door (`door.ts`): constant host per service, `MANYTHREADS_BRIDGE_<SERVICE>_FAKE_BASE` honoured outside production only, no
redirects, 10 seconds, 256 KB of answer. A refusal of the token marks the account `attention`. **WhatsApp's 24-hour window**: when the person's last message is older than 24 hours the answer is kept as `waiting` and sent when they next write
(at most 20 at once); waiting rows older than 7 days are marked dead by the nightly purge.

**Offboarding**: suspending or removing a member deletes their identities; archiving a channel deletes its links; removing an account deletes its credentials, links and chats.

## Interface other code can rely on

- `BridgeAdapter` (`src/adapter.ts`): `verify(account, req)`, optional `challenge`, `parse(account, body)` -> `InboundMessage[]` (`updateId`, `chat {id, kind private|group, title}`, `sender {id, label}`, `text`, `command`), `send(account, chat, text)` -> external
  message id, optional `connect(account, callbackUrl)` -> `{handle, externalAppId}` and `disconnect`, and two hooks added for Slack and Teams: `prepare(account, req)` (async, runs before the synchronous `verify`; Teams reads Microsoft's signing keys there) and
  `handshake(account, body)` (answers a service's address check with a plain-text body; Slack's `url_verification`). `BRIDGE_ADAPTERS` (`adapters/index.ts`) is the registry.
- Shared: `Message.meta.via.provider`, the `api/bridges` routes and entities, the catalog entries `telegram`, `whatsapp`, `slack` and `teams` (`connectors/catalog-chat.ts`, all available).
- Web: `/settings/workspace/chat-apps` (`screens/bridges/AdminChatApps.tsx`), `/account/chat-apps` (`AccountChatApps.tsx`), the Chat apps tab of the Integrations dialog (`webhooks/ChatBridgeTab.tsx`), the "via Telegram" note (`channels/MessageVia.tsx`).
- Stand-ins for tests: `tools/fake-saas` `telegram`, `whatsapp`, `slack` and `teams` (`MANYTHREADS_BRIDGE_<SERVICE>_FAKE_BASE`, honoured outside production only).

## Slack and Teams (work package B2)

**Slack** (`adapters/slack.ts`). The admin makes a Slack app, gives manythreads its **bot token** (`xoxb-...`) and **signing secret**, turns the account on (the token is checked with `auth.test`), then pastes the address shown on the admin page as the
Request URL under Event Subscriptions and subscribes to `message.channels` and `message.im`. Slack's first call is a `url_verification`: the door answers it with the challenge as plain text (`handshake`). Every call is checked with
`X-Slack-Signature` (`v0=` + HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the signing secret, constant time) and refused with 401 when the signature is missing or wrong or `X-Slack-Request-Timestamp` is more than 5 minutes off either way.
Events are read from `event_callback` (`message` events only); a message with a `bot_id` or a subtype (edits, joins, bot posts, including our own) is skipped so nothing loops; a repeated `event_id` is read once. A chat is the Slack channel id;
`im` is a private chat, the rest are groups. Replies are `chat.postMessage` with the bot token; the text goes out with `&`, `<` and `>` escaped, so a message cannot make a Slack mention or link. Slack swallows a message that starts with `/`, so commands
are plain words: `connect 12345678` in a channel the bot was added to, `start 12345678` (or just the code) in a direct message, `unlink`, `bot [name]`; a `/` or `!` in front also works. 429 is retried after `Retry-After`; `invalid_auth`,
`token_revoked` and `account_inactive` mark the account `attention`.

**Teams** (`adapters/teams.ts`, `adapters/jwt.ts`), through the Bot Framework. The admin makes an Azure bot, gives manythreads its **application (client) id** and **client secret** (stored as the account's `bot_token`: the one credential the bot
calls out with), turns the account on (manythreads asks Microsoft for an access token to check them), and pastes the address shown on the admin page as the bot's messaging endpoint, then adds the Teams channel to the bot. Teams calls the door
with `Authorization: Bearer <JWT>`. `jwt.ts` checks it with `node:crypto` only: three base64url parts of bounded size, `alg` exactly `RS256` (no `none`, no HMAC, no `crit`), a `kid` found in the key set Microsoft publishes at
`login.botframework.com/v1/.well-known/keys` (the constant path; the `jwks_uri` in a document is never followed), RSA 2048 to 8192 bits and `use: sig`, the signature, `iss` equal to `https://api.botframework.com`, `aud` equal to the bot's application id,
`exp` and `nbf` with 5 minutes of clock difference, the `serviceurl` claim equal to the activity's `serviceUrl`, and the key endorsed for `msteams`. Keys are kept 24 hours; an unknown `kid` makes at most one new look a minute (a flood of forged ids
costs one fetch); if Microsoft cannot be reached the held keys are used for up to a week more. A reply needs the activity's `serviceUrl`, which the activity carries and so is hostile: a chat id is `<serviceUrl>|<conversation id>` (at most 200 characters)
and is made, and later dialled, **only** when the host is on the Microsoft list (`*.botframework.com`, `smba.trafficmanager.net`, https, no port, no credentials, a plain region path). Any other address is never contacted, and the message from it is not
stored. Replies are POSTed to `<serviceUrl>/v3/conversations/<id>/activities` as plain text with a token from `login.microsoftonline.com` (kept until a minute before it ends; a 401 gets one new token and one retry). Text is plain with
`<at>Name</at>` for mentions: the bot's own mention is removed, another person's becomes their name. In a channel the bot only sees messages that mention it, so a command starts with the mention (`@Bot connect 12345678`). A reply thread
(`...;messageid=...`) belongs to its channel as a whole. Activity ids are unique only inside a conversation, so the replay key includes the conversation.

Both: unlinked senders are dropped before anything is stored (same rules as Telegram), the same flows and limits apply, tokens never appear in an error or a log, and the admin page shows the address to paste and what to turn on. The door's standing rules
(constant host, no redirects, 10 seconds, 256 KB) are unchanged; the extra Microsoft hosts (keys, token) are constants of the door (`BRIDGE_AUX_BASES`), not read from any payload.

## Known limits

The wrong-code lockout is in memory, per server replica. Attachments are not carried: a message with files is sent as text plus a note "N files attached in manythreads". Only text is read from a chat (photos, voice and stickers are ignored). No route lets an admin
unlink another person's chat user (they are removed when the person leaves). Telegram text is plain (no formatting); WhatsApp has direct chats only. Slack and Teams read plain text only (no files, cards or reactions); Teams answers into the conversation it was asked in (no proactive first message to a person who never wrote); Slack needs the bot added to a channel before it sees it. Microsoft's key cache is per server replica.

## Code layout

`src/adapter.ts` (the seam), `src/adapters/` (one file per service), `src/door.ts` (the one outbound door), `src/text.ts` (cleaning of hostile text), `src/accounts.ts` (account rows and sealed credentials), `src/identity.ts` (codes, lockout,
offboarding), `src/inbound.ts` (the public door), `src/outbound.ts` (fan-out, send, reply, purge jobs), `src/dm.ts` (private chat with a bot), `src/routes-admin.ts`, `src/routes-me.ts`, `src/routes-channel.ts`.

## Tests

`packages/plugins/bridges/test/` : `telegram.test.ts`, `whatsapp.test.ts`, `slack.test.ts` and `teams.test.ts` (the token check, the adapters and end to end against the real server and the stand-ins, including forged, stale and wrong-issuer/audience/expired/unknown-key tokens and an address outside the Microsoft list), `text.test.ts`, `adapters.test.ts` (verify, parse, hostile input, the outbound door) and `rls/bridges.test.ts` (the database rules).
