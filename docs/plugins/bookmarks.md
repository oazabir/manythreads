# bookmarks

The `bookmarks` plugin lets a person keep a thread or a message to find it again, and lists them on the Bookmarks page (`/t/<team>/bookmarks`). Bookmarks are
the person's own: nobody else sees them, a workspace admin included, and a bot has none. To use it, nothing needs setting up: the plugin is loaded with the
others and adds its table with its first migration. Files (attachments, Personal files and files of a team's repository) are a later step; the table
already accepts them, the route refuses them for now ("Files cannot be bookmarked yet.").

Plan and owner decisions: `docs/plans/bookmarks.md` (P36-08).

## What a person sees
- **Thread:** a bookmark button at the top right of the thread (the last of the thread's own tools, in the right panel and on the Threads page). Outline when
  off, filled when on; "Thread bookmarked" / "Bookmark removed".
- **Message:** "Bookmark" / "Remove bookmark" in a message's More menu, above the Later items; the first message of a thread offers "Bookmark message" and
  "Bookmark thread". A bookmarked message shows a small filled bookmark beside its author's name.
- **Threads view:** the card menu's "Bookmark thread"; the filter's **Bookmarked** button (`?bookmarked=1`) lists the bookmarked threads (on Followed every
  one of them, followed or not, with or without replies; on Unread and Mine it narrows that tab), with the filter's words and People only.
- **Sidebar:** a Bookmarks entry, drawn only while the person has at least one bookmark (`showWhen: 'bookmarks.total'` in `shell/nav.ts`); a guest gets it too (they bookmark messages of the channels shared with them) and opens the page at `/t/shared/bookmarks`.
- **Bookmarks page:** Threads and Messages tabs with counts (`?tab=thread|message`), newest first. A thread opens its channel with the thread on the right;
  a channel message opens the channel at it; a reply opens its thread on the right. Something the person can no longer read says "No longer available"
  and can only be removed. j and k (or the arrow keys) move, Enter opens, Delete removes with Undo.

"Later" (the reminders plugin) is a different thing: a to-do list of messages with an optional reminder. The channel header's shared links (the API's
`channel_bookmarks`) are called **Links** in the UI.

## Data
`app.bookmarks` (migration `0001_bookmarks.sql`): one row per person and target, with a `kind` of `thread`, `message`, `file` or `repo_file`, each kind filling
its own columns (a CHECK per kind, a partial unique index per kind). Ids and a path only, never text. Rows are never changed (a trigger refuses every
UPDATE); at most 500 per person (a trigger that takes an advisory lock per person, so two racing inserts cannot pass the cap). Row-level security is
forced and has no admin or system policy: a person reads, adds and removes their own rows; an insert must point at a channel they can read (thread,
message), a file their file policies show (file) or a team they can read (repo_file). A deleted channel or team takes its bookmarks with it.

No events and no audit rows (private, no text); after each change the person's own tabs get the push `bookmarks.changed {id, kind, key, on}`, delivered
when the transaction commits.

## API (`packages/shared/src/api/bookmarks/bookmarks.ts`)
People only (a bot gets 403); each route has a rate limit.

| Route | What it does |
| --- | --- |
| `GET /api/bookmarks?kind=thread\|message\|file&cursor&limit≤50` | One page, newest first, with `counts` per tab; `item` is null for what the caller can no longer read |
| `GET /api/bookmarks/keys` | Every bookmark as `{id, kind, key}` (at most 500) and `total`: fills the icons and the sidebar entry |
| `PUT /api/bookmarks` `{target}` | Adds one: 201 new, 200 already there, 403 cannot see it, 404 gone, 409 full, 400 a reply as a thread or a file kind |
| `DELETE /api/bookmarks/:bookmarkId` | Removes one of the caller's own (404 otherwise) |

The threads plugin's `GET /api/teams/:slug/threads?bookmarked=1` asks this plugin's provider (`provider.bookmarks`, `BookmarksProvider` in
`@manythreads/sdk`) for the caller's bookmarked threads; a server without the plugin answers an empty list.

## Web
`clients/web/src/bookmarks/` (the store of keys with optimistic changes and the push, the menu items and the mark, the page's rules), the page
`screens/bookmarks/BookmarksScreen.tsx`, styles `styles/bookmarks.css`.

## Tests
`packages/plugins/bookmarks/test/rls/bookmarks-rls.test.ts` (privacy, refusals, shapes, no UPDATE, cascade, the cap under a race),
`packages/plugins/bookmarks/test/bookmarks-api.test.ts` (routes, nothing leaked after access ends, paging and counts, a bot refused, the push, the Threads
filter), `clients/web/test/bookmarks.test.ts`, `e2e/channels/bookmarks.spec.ts`.
