# Message pins and live chips (Next ten, item 8: P31-07, P14-11, P9-05)

Two small features that share one goal: things in a channel that point at other things should work. A person can **pin** a message (keep it in
the channel's list of pinned messages, the way a notice is pinned to a board), find the pinned ones with `has:pin` in search, and see the
person, channel, card and approval **chips** a bot's screen (a "surface": the small screen a bot posts into a message, PLAN P9-03) draws, with the
real names and a way to open each one. Pins are separate from P9-09 (exporting a surface to pages), which stays not built.

## What exists (file:line)

- Messages and their feed: `packages/plugins/channels/src/routes-messages.ts:142` (list), `src/service.ts:216` (`findChannelMessage`, used by every push of a
  changed message), `src/rows.ts:127` (`toChannelMessage`), `packages/shared/src/api/channels/common.ts:65` (`ChannelMessage`).
- The model to copy for a small per-channel table: bookmarks, `migrations/0010_channel_bookmarks.sql` (read set for `SELECT`, post set for `INSERT`/`DELETE`)
  and `src/routes-bookmarks.ts` (cap checked after the insert).
- Events: `packages/shared/src/events/registry.ts:226`; reactions emit through `ctx.audit.emit` (`src/service.ts:569`), which validates against the registry
  and writes the event and the outbox (the queue of events written in the same transaction as the change) together. Live pushes: `src/service.ts:240-265`,
  push schemas `packages/shared/src/api/channels/realtime.ts`.
- Search words: `packages/shared/src/api/search/syntax.ts:12` says `has:pin` waits for pins; `SEARCH_HAS` at `:17`, the parser at `:119`.
  The server: `packages/plugins/search/src/service.ts:55` calls `app.search_messages` (ten arguments, `migrations/0004_filters_pages.sql:28-140`),
  `resolveFilters` at `:161`, which kinds a filter applies to at `:203`.
- Web, message row: the More menu `clients/web/src/channels/MessageRow.tsx:362`, `RowActions` at `:103`; actions built in
  `clients/web/src/screens/ChannelView.tsx:228` and `channels/ThreadPanel.tsx`; pushes handled in `channels/store.ts:177`.
- Web, channel details menu: `clients/web/src/shell/ChannelDetails.tsx:118` (on a phone it also carries the header's tools, P34-05,
  `shell/headerMenu.ts`). Right panel types: `clients/web/src/kernel/panel/builtins.tsx:59` (the Members panel, `shell/MembersPanel.tsx`, is the model).
- Web, search chips: `clients/web/src/search/SearchFilterBar.tsx:18` (chip labels) and `:70` (the filter form).
- Surfaces: `clients/web/src/surfaces/host.ts` (`SurfaceHost`: what the page lends a surface), `surfaces/views.tsx:248-330` (EntityCard, PersonChip,
  ChannelLink, ApprovalCard draw the bot's label when no host is given). Only `surfaces/answerView.tsx:44` provides a host, and only for the Answer part;
  `surfaces/SurfaceMessage.tsx:135` (the bot's screen in a message) provides none. Card links: `/t/<team>/boards?card=<id>`
  (`channels/todo-card/TodoCard.tsx:37`); an approval opens at `/t/<team>/approvals?approval=<id>` (`screens/approvals/ApprovalsScreen.tsx:41`).

## Decisions

1. **Who may pin: whoever can post in the channel**, and the same people unpin. P14-11's text only asks that `has:pin` find pins; it does not give pinning
   to leads alone. A pin, like a bookmark, is a shared note on the channel, and the bookmarks bar (P14-12) already gives it to the post set
   (`app.visible_channel_ids('post')`). A direct message pins too (both people can post there), so its details menu now has two items, Notifications and
   Pinned messages (the DM test of `e2e/channels/channel-header.spec.ts` says so). A guest with a read grant sees pins and cannot pin. A bot cannot pin (no capability is added; it can still search
   `has:pin` through `messages.search`'s visibility). An archived channel cannot change its pins.
2. **A table of its own**, `app.message_pins` (channels migration `0020`), not columns on `app.messages`: the messages update policy is the author's, and
   a pin is somebody else's act on the message. One row per pinned message (`message_id` primary key), at most **100 per channel** (checked after the
   insert, as bookmarks do). A thread reply can be pinned. A deleted message drops out of the list and of search (both filter `deleted_at`), and its pin
   row goes when the message is deleted through the route.
3. **One event**, `channel.message.pin_changed` (`domain.noun.verb`): channel, team, message, the actor, `pinned` true or false. Only a real change is an
   event (pinning a pinned message answers `changed: false`). Not audited: it says nothing about content and no audit row is asked for.
4. **One live push**, `message.pin_changed` (`{ channelId, messageId, threadRootId, pinned }`), to the channel's audience, so the row's marker and the
   open pinned list change in every tab. Every message the API returns carries `pinned: { by, at }` when it is pinned.
5. **`has:pin`** is a fourth `has:` word. Search migration `0008` replaces `app.search_messages` with an eleventh argument `p_has_pin`; the filter is
   `m.id = ANY(<the caller's pinned ids>)`, read through the pins table's own read policy, so it never widens what the caller reads. `has:pin` is about
   messages only: threads, files, pages and meetings are not listed.
6. **Chips**: one host for every surface in a message (`surfaces/pageHost.tsx`, `usePageSurfaceHost`), provided by `SurfaceMessage` (and so outside the
   Answer too). It looks things up **as the viewer**, through the routes they already use: people from the roster the shell already holds (by person or
   actor id), a channel through `GET /api/channels/:id` (403 means "draw the bot's label, not a link"), a card through `GET /api/teams/:slug/tasks/:id`,
   an approval's status from the team's approvals lists. Each answer is cached for the page. The host gains `openPerson`, `openEntity` and
   `openApproval`: a person opens the Member panel, a channel opens the channel, a card opens the board at the card, an approval opens the approvals page at it.
   Nothing the bot wrote becomes an address: the host builds each link from the id.

## Data and migration

- `packages/plugins/channels/migrations/0020_message_pins.sql`: `app.message_pins (message_id uuid PK → messages ON DELETE CASCADE, workspace_id, channel_id
  → channels ON DELETE CASCADE, pinned_by → actors ON DELETE SET NULL, pinned_at timestamptz)`, indexes on `(channel_id, pinned_at DESC)`, `workspace_id`,
  `pinned_by`. RLS enabled and forced: `SELECT` with the hoisted read set, `INSERT` with the post set and `pinned_by = app.actor()`, `DELETE` with the post set.
  The insert also checks that the message is in that channel (a trigger-free `WITH CHECK` through an `EXISTS` on `app.messages`, which has its own read policy).
- `packages/plugins/search/migrations/0008_has_pin.sql`: drop the ten-argument `app.search_messages`, create it with `p_has_pin boolean DEFAULT false` (the
  body of 0004 with one more condition), grants as before. Forward-only; no applied file is edited.
- Shared: `api/channels/pins.ts` (routes, request/response, `MAX_CHANNEL_PINS`), `ChannelMessage.pinned`, the push, the event file and its registry entry,
  `SEARCH_HAS` gains `pin`.

## Routes (channels plugin, `src/routes-pins.ts`)

- `GET /api/channels/:channelId/pins` → the pinned messages, newest pin first, each a whole `ChannelMessage` (reader's reactions, author, attachments).
- `PUT /api/channels/:channelId/messages/:messageId/pin` → `{ pinned: true, changed }`; 404 unknown message, 409 deleted message, archived channel or the 101st pin, 403 no post right.
- `DELETE /api/channels/:channelId/messages/:messageId/pin` → `{ pinned: false, changed }`.

## Web

- Row: "Pin to channel" / "Unpin from channel" in the More menu (whoever can post); a small pin mark and "Pinned" in the row's header line when pinned.
- The channel's pinned list: a right-panel type `pins:<channelId>` ("Pinned in #dev"), each message with author, time, text, "Open" (jumps to it) and Unpin.
  Reached from the channel details menu ("Pinned messages", on desktop and phone alike; on the phone this is the same menu that holds the header's tools, P34-05).
- Search: the chip "Pinned" and a "are pinned" tick in the filter form.
- Chips: `SurfaceMessage` provides the page host; the four parts become buttons that open when the host can open them, with the resolved name.

## Tests

- channels: `test/pins.test.ts` (pin, unpin, list, cap, permissions: member, non-member of a private channel, guest, archived; the event and the push;
  `pinned` on the list and get routes); events test's manifest list; RLS (`test/rls/channels-plugin.test.ts`: the table's policies refuse a non-member).
- search: `has:pin` in `test/search-filters.test.ts` (only pinned, only readable, an unpinned one drops, `has:pin` lists no files); shared syntax test.
- shared: event contract and the parser.
- web: unit tests of the pin menu item and marker (MessageRow), the pins panel's model, the page host (name, open, the label when the lookup fails), the chip label.
- e2e (written, not run here): `e2e/channels/pins.spec.ts` (pin from the menu, the marker, the list from the details menu, unpin; `has:pin` in search).

## Order

shared schemas → channels migration and routes → search migration → tests of both → web (row, panel, details menu, search chip) → surfaces host →
web tests → typecheck, eslint and CSS lint of touched files → docs (channels.md, search.md, surfaces.md) and the ledger rows.

## Risks

- Replacing `app.search_messages` copies a 110-line function: the copy must be the 0004 body exactly plus one condition (diffed by eye and by the existing
  search tests, which still pass ten arguments by default).
- The search RLS test database lists plugin migrations by hand; it needs channels' 0020 before search's 0008.
- The chips host must never use the bot's access: every lookup is a normal request of the viewer's session, and a refusal draws the bot's label.
- Many chips on one screen would each fetch: lookups are cached by id for the page and a channel/card is fetched once.

## Done

Checked live on the deployed site (not by this change: it is not deployed here): pin and unpin from the More menu as a member, the marker in a second
tab, the pinned list from the details menu at 1280 px and 390 px, `has:pin` in search, a guest sees pins and has no Pin item; a bot's screen with a
person, channel, card and approval chip shows the names and each opens.
