# Bookmarks (P36-08, owner 2026-11-24)

A person bookmarks a **thread**, a **message** (in a channel, a thread, a DM or a bot chat) or a **file**, and finds them again under **Bookmarks** in the
sidebar, an entry shown only while the person has at least one bookmark. Bookmarks are the person's own. A bookmark of something the person can no longer read
stays in the list as "No longer available", showing nothing of the item.

## What exists and how this fits beside it
- **Later** (P14-04, `packages/plugins/reminders`, `app.later_items`, web `clients/web/src/later/*`, the fourth tab of `screens/ThreadsInbox.tsx`) holds
  messages only, each with a done state and an optional reminder: a to-do list, not a reference list. **Kept as it is; Bookmarks sit beside it.** Later =
  "come back and finish this"; Bookmarks = "keep this to find it again". Merging was rejected: `later_items` has a done-state guard, a reminder job, a cap of 200
  and one message per row; a file or a thread is not a to-do. So the words stop overlapping:
  - The Threads view card menu "Save" / "Remove from saved" (`screens/ThreadCard.tsx`, which saves the first message to Later) becomes **Bookmark thread** /
    **Remove bookmark**.
  - Later's icon `SaveForLaterIcon` (a bookmark glyph, `shell/icons.tsx`) becomes a clock; the bookmark glyph is then only Bookmarks'.
  - Later keeps "Mark for later" and drops the word "saved".
- **The channel header's link bar** (P14-12: `channel_bookmarks`, `channels/src/routes-bookmarks.ts`, web `channels/BookmarksBar.tsx`, the details-menu item
  "Add a bookmark" in `shell/headerMenu.ts`) is a channel's shared links. **Renamed in the UI to "Links"**: region "Channel links", "Add a link", `HeaderToolKey`
  `bookmark` → `link`, a link icon; web code `BookmarksBar` → `ChannelLinksBar`, `fetchBookmarks`/`addBookmark`/`removeBookmark` → `fetchChannelLinks`/
  `addChannelLink`/`removeChannelLink`. Table, routes and shared types (`ChannelBookmark`, `BookmarkKind`) stay: the API does not change.
- **Pins** (P31-07) are the channel's, shared; bookmarks are personal. Both stay in the More menu.

## What a person sees
- **Thread pane:** a bookmark toggle at the top right of the thread header, last in `ThreadTools` (`channels/ThreadTools.tsx`: `'bookmark'` in
  `ThreadToolKey`, last in `THREAD_TOOL_ORDER`), left of Close; the same in the Threads view's main pane. Outline when off, filled when on; `aria-pressed`,
  label "Bookmark thread"; toast "Thread bookmarked" / "Bookmark removed".
- **Message More menu** (`channels/MessageRow.tsx`; channel, thread reply and DM rows): **Bookmark** / **Remove bookmark** above the Later items; a bookmarked
  row shows a small filled mark by its time (like `PinnedMark.tsx`, sr-only "Bookmarked"); the touch long-press menu (`rowBar.ts`) has the item; a thread's
  first message offers "Bookmark message" and "Bookmark thread".
- **Bot chat** (`screens/chat/ReplyActions.tsx`): a bookmark button next to Copy on each answer; the person's own messages get it too.
- **Files:** "Bookmark" / "Remove bookmark" in the row menu (`screens/files/actions.tsx` `rowEntries`, files only, every store: git, attachments, personal);
  an icon toggle in `FileView.tsx` and `FilePreview.tsx`; a mark on bookmarked rows (`FileItems.tsx`).
- **Sidebar:** a `CORE_NAV` row `{ id: 'bookmarks', label: 'Bookmarks', path: '/bookmarks', icon: 'bookmarks', showWhen: 'bookmarks.total' }`, drawn only
  while the count is above 0, no badge; on a phone in the drawer and the You sheet.
- **Bookmarks page** `/t/:team/bookmarks` (`screens/bookmarks/BookmarksScreen.tsx`): `PageHeader` "Bookmarks", tabs **Threads · Messages · Files** with
  counts (`?tab=`), newest first, Remove on each row. Thread row: title, place, replies, last reply. Message row: author, snippet, place ("# dev", "Thread in
  # dev", "Direct message", "Conversation with Brain"), time. File row: name, place, size. An unreadable item: "No longer available", Remove only.
- **Clicks** (through `useOpenMessage` / `messageLocation`, `shell/messageLink.ts`):
  - thread → its channel or DM with the thread on the right (`?message=<root>&panel=thread:<root>`); a bot-chat thread → `/t/:team/chat?bot=&c=<root>`;
  - channel message → the channel scrolled to it and flashed (the existing `?message=`);
  - thread reply → the channel with the thread on the right and **the reply scrolled to and highlighted** (new: `ThreadBody` reads `?reply=<id>`, waits as
    `ApprovalInThread.tsx` does);
  - bot-chat message → **new** `?message=<id>` in the chat screen, same scroll and highlight;
  - file → a git file `spaceHref(team, { open: path })`, a Personal file `/files?open=<path>`, an attachment the right-panel `file:<fileId>`; a file that is
    gone shows the viewer's "no longer there".
- **Threads view filter:** a **Bookmarked** toggle in `inbox/FilterBar.tsx` beside "People only", `?bookmarked=1`, combinable with `who` and `q`; on Followed it
  lists every bookmarked thread (followed or not, with or without replies); empty state "No bookmarked threads. Use the bookmark at the top right of a thread."

## Data (new plugin `packages/plugins/bookmarks`, dependsOn channels, files)
`migrations/0001_bookmarks.sql`, modelled on `reminders/0001_later.sql`: `app.bookmarks (id, workspace_id, person_id, kind CHECK thread|message|file|repo_file,
message_id, channel_id FK cascade, thread_root_id, file_id, team_id FK cascade, path ≤1024 no NUL, created_at)`; one CHECK per kind; partial unique indexes per
kind; `(person_id, kind, id DESC)`. Ids and paths only, never text. No UPDATE (a guard trigger). Cap 500 per person (advisory-lock trigger as `later_items_cap`,
"You have 500 bookmarks. Remove some first."). RLS enabled and forced, no admin policy: SELECT/DELETE own; INSERT own, plus thread/message `channel_id = ANY
(app.visible_channel_ids('read'))`, file readable under the caller's file policies, repo_file `team_id` readable. The list LEFT JOINs messages, channels and
files under the caller's RLS; an item is readable only when the row was found and is not deleted, else `item: null`. No events or audit rows (private, no text,
as Later); live updates to the person only.

## API (`packages/shared/src/api/bookmarks/bookmarks.ts`; `BookmarkId`)
`BookmarkTarget` = `{kind:'thread', rootMessageId} | {kind:'message', messageId} | {kind:'file', fileId} | {kind:'repo_file', teamId, path}`; `SavedBookmark
{ id, target, createdAt, item | null }`. Routes (people only, rate-limited): `GET /api/bookmarks?kind&cursor&limit≤50` → `{items, nextCursor, counts}`;
`GET /api/bookmarks/keys` → `{total, items:[{id, kind, key}]}` (≤500, for filled icons and the sidebar); `PUT /api/bookmarks` (idempotent: 201 new, 200
existing, 403 cannot see, 404 gone, 409 cap); `DELETE /api/bookmarks/:id` → `{removed}`. Threads: `ListThreadsQuery.bookmarked`, `listInbox` asks a new
provider `bookmarks` (`provider.bookmarks`). Push `bookmarks.changed {id, kind, key, on}` to the person after each write.

## Web
`clients/web/src/bookmarks/store.ts` (as `later/store.ts`): loads `/keys` once, `has`, `toggle`, `total`; optimistic with rollback; follows the push so other
tabs keep in step; hides every control when the server has no bookmarks. `NavContribution.showWhen` (a count source) and `visibleNav` dropping an entry at 0;
`shell/counts.ts` `bookmarks.total`; icons. Keyboard: the tabs as a tablist, j/k and Enter in the list, Delete removes with a 5 s Undo; live region. Phone
(390 px): one column, tabs on one row, 44 px rows, Remove under "…", the pane icon in the one-row pane bar.

## Tests
RLS (others and admins see none; inserts for unreadable channels, files, teams refused; cap under a race; no UPDATE; cascades); routes (idempotent PUT, the
refusals, `item: null` with nothing leaked after losing access or deletion, counts, paging, bots refused, push only after commit); threads filter on each tab
with `who` and `q`; web unit (`visibleNav` with `showWhen`, the store, click targets, reply highlight, header menu "Links"); e2e `e2e/channels/bookmarks.spec.ts`
(thread from the pane, the sidebar entry, the filter, open from Bookmarks; a reply highlighted; a bot answer; a file; a second tab live; the last removed hides
the entry; lost access; 390 px).

## Order of work
1. Server (plugin, migration, RLS, routes, schemas, push, provider) and threads and messages in channels: store, thread-pane toggle, More-menu item and row
   mark, the sidebar entry, the page with Threads and Messages, the Threads filter, the Links rename, Later's clock icon and wording.
2. Bot chat and exact landing: the answer bookmark, `?message=` in bot chat, `?reply=` in the thread pane, phone polish and the You sheet row.
3. Files: the file and repo_file kinds in the Files row menu, viewer and panel toggles, row marks, the Files tab and its clicks.

A git file renamed or moved keeps its bookmark on the old path (the viewer says it is no longer there); re-keying on rename is left out. `is:bookmarked` in search
is a later step.
