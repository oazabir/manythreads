# Plugin: bridges (chat apps)

Telegram, WhatsApp, Slack and Microsoft Teams joined to manythreads (PLAN Bundle D, P16-09). Status: the core, identity, Telegram, WhatsApp and the web pages are built (work package B1); Slack and Teams
(`adapters/slack.ts`, `adapters/teams.ts`, work package B2) are still stubs and answer "not built yet".

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
  message id, optional `connect(account, callbackUrl)` -> `{handle, externalAppId}` and `disconnect`. `BRIDGE_ADAPTERS` (`adapters/index.ts`) is the registry. Slack and Teams fill their stubs and change nothing else.
- Shared: `Message.meta.via.provider`, the `api/bridges` routes and entities, the catalog entries `telegram` and `whatsapp` (`connectors/catalog-chat.ts`, available; `slack` and `teams` stay planned).
- Web: `/settings/workspace/chat-apps` (`screens/bridges/AdminChatApps.tsx`), `/account/chat-apps` (`AccountChatApps.tsx`), the Chat apps tab of the Integrations dialog (`webhooks/ChatBridgeTab.tsx`), the "via Telegram" note (`channels/MessageVia.tsx`).
- Stand-ins for tests: `tools/fake-saas` `telegram` and `whatsapp` (`MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE`, `MANYTHREADS_BRIDGE_WHATSAPP_FAKE_BASE`).

## Known limits

The wrong-code lockout is in memory, per server replica. Attachments are not carried: a message with files is sent as text plus a note "N files attached in manythreads". Only text is read from a chat (photos, voice and stickers are ignored). No route lets an admin
unlink another person's chat user (they are removed when the person leaves). Telegram text is plain (no formatting); WhatsApp has direct chats only.

## Code layout

`src/adapter.ts` (the seam), `src/adapters/` (one file per service), `src/door.ts` (the one outbound door), `src/text.ts` (cleaning of hostile text), `src/accounts.ts` (account rows and sealed credentials), `src/identity.ts` (codes, lockout,
offboarding), `src/inbound.ts` (the public door), `src/outbound.ts` (fan-out, send, reply, purge jobs), `src/dm.ts` (private chat with a bot), `src/routes-admin.ts`, `src/routes-me.ts`, `src/routes-channel.ts`.

## Tests

`packages/plugins/bridges/test/` : `telegram.test.ts` and `whatsapp.test.ts` (end to end against the real server and the stand-ins), `text.test.ts`, `adapters.test.ts` (verify, parse, hostile input, the outbound door) and `rls/bridges.test.ts` (the database rules).
