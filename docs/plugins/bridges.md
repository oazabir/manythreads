# Plugin: bridges (chat apps)

Telegram, WhatsApp, Slack and Microsoft Teams joined to manythreads (PLAN Bundle D, P16-09). Status: contracts, migration and stubs (P16-12); every route answers 501 "Not built yet" until work package B1
(Telegram, WhatsApp, the shared pieces) and B2 (Slack, Teams) fill them in.

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

## Code layout

`src/adapter.ts` defines `BridgeAdapter` (`verify`, `challenge`, `parse`, `send`), `BridgeAccountRef`, `BridgeRequest`, `InboundMessage`; one file per service in `src/adapters/`. `identity.ts`, `dm.ts`,
`inbound.ts`, `outbound.ts` and `routes-*.ts` are the stubs the work packages fill.
