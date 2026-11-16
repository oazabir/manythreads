# threads

Read a thread, follow and unfollow it, and the Threads inbox of a team (SPEC section 6.1, PLAN P3-06, criterion 4). Code: `packages/plugins/threads`. Schemas:
`packages/shared/src/api/threads`. The tables (`threads`, `thread_follows`, `messages`) and the reply path belong to the [channels plugin](./channels.md); this plugin has no
migration and `dependsOn` channels.

## Replying

A reply is the channels plugin's `POST /api/channels/:channelId/messages` with `threadRootId` set to the first message of the thread. There is deliberately no second reply route
here: posting is one insert path that also writes the event, the live push, the unread counts, the mentions and links, and the automatic follow, and plugins may not import each other,
so a copy would drift. `GET /api/threads/:rootId` returns the `channel.id` the client posts to.

## Following: one source of truth

`thread_follows` is the membership of a thread: it decides who gets the thread's unread counts (`app.thread_follower_ids`) and what the Followed tab lists.
`read_state.followed` (the kernel's flag, shown by `GET /api/read-state`) is a **mirror** of it:

- a trigger on `thread_follows` (channels migration `0003`) writes the mirror on every insert and delete, so each path agrees, including the follow a reply creates for the root's
  author while someone else is the caller (RLS lets a person write only their own `read_state` row);
- the follow and unfollow routes call `ctx.readState.setFollowed` first (it emits `reading.state.changed` and pushes the change to the person's sockets), then write
  `thread_follows`; by then the mirror already agrees and the trigger writes nothing.

Who follows when:

| What happens | Follows |
|---|---|
| a reply is posted | the replier (every time they reply), and the root's author **on the first reply only**, so unfollowing a thread you started is not undone by the next reply |
| `POST /api/threads/:rootId/follow` | the caller (works before the first reply too; the thread shows in the inbox from its first live reply) |
| `POST /api/threads/:rootId/unfollow` | stops following **and** marks the thread read up to its latest reply: not following means not being told, so the Unread tab and the badge never list a thread the person left |

## Routes

| Method and path | What it does |
|---|---|
| `GET /api/threads/:rootId?before=&limit=` | `{ channel, root, thread, replies }`: the root as a `ChannelMessage`, the channel it is in, `thread` (title, `replyCount`, `lastReplyAt` or null, `followed`, `unreadCount`, `lastReadId`) and the live replies newest first, paged by `before` like the channel list (`replies.nextCursor` is the next `before`). A message with no reply yet opens as an empty thread. 403 for a message the caller cannot see or that does not exist (the same answer), 404 for a message that is itself a reply. Reading does not mark anything read: the client calls `POST /api/read-state/mark`. |
| `POST /api/threads/:rootId/follow`, `POST .../unfollow` | `{ followed, changed }`; idempotent (`changed: false` the second time). 403 for a message the caller cannot see, 404 for a reply, 409 when the root is deleted (follow). |
| `GET /api/teams/:slug/threads?tab=followed\|unread\|mine&limit=&cursor=` | The Threads inbox, `Page<ThreadInboxItem>`: root id, channel, title, root author, `replyCount`, `lastReplyAt`, `followed`, `unreadCount`, `mine`, `lastReply` (`{ authorName, preview }` of the newest live reply, named through `app.message_authors` so only what the caller can read; null when none is left), and what the web card draws: `rootAuthor` (who wrote the first message, named the same way, null when the caller may not read the author's messages), `participants` (up to five authors who wrote in the thread, live messages only: the root's author first, then the newest writers) with `participantCount` (all of them), and `mentionCount` (unread replies written by someone else that name the caller as a person or bot; `@channel` is not counted; never more than `unreadCount`, and zero once the thread is read or unfollowed). Newest reply first, keyset cursor (opaque; a bad one is 400). `limit` 1 to 100 (default 30). |

### The inbox tabs (criterion 4)

The web inbox has a fourth tab, **Later** (P14-04): the person's saved messages and reminders. It is not served by this plugin; it reads `GET /api/later` from the reminders plugin
([reminders.md](./reminders.md)) and is hidden on a server without that plugin.

| Tab | Lists |
|---|---|
| `followed` | rows of `thread_follows` of the caller |
| `unread` | threads with `read_state.unread_count > 0` for the caller (the partial index `read_state_unread`), followed or not, so the tab always agrees with the unread summary |
| `mine` | threads whose root message the caller wrote |

A thread is listed once it has a live reply (`reply_count > 0`). Only the channels of the team in the path are listed (direct-message threads belong to no team, so they are not in a team
inbox; the DM list carries their unread). An unknown or unreadable team is an empty inbox (200), like the channel directory; a **guest**, who sits on no team, gets the threads of the channels
they were granted whatever the slug.

**Phase 6 hook ("or holds a task in").** The `mine` predicate is one SQL expression, `MINE` in `src/inbox.ts`, marked `PHASE 6 HOOK`. The tasks plugin adds its source as one more `OR`
(`OR t.root_message_id IN (SELECT thread_root_id FROM app.tasks WHERE owner_id = <actor> AND state <> 'done')`); the tab, ordering, cursor and item shape do not change. Until then the tab holds
threads the person started.

### The Threads view as a bird's-eye view (P29-14 to P29-18)

The inbox row is the starting message (the head), the reply count, then one block: the **latest reply**, or the **mention** that waits on the caller. `GET /api/teams/:slug/threads` therefore also takes
`q` (words, each in the channel's name or any message of the thread, case and accent insensitive) and `mentions` (`a|b,c`: every comma part must name one of the listed actors, so `@name` filters by who is mentioned),
and each item carries `lastReply` (`authorName`, `preview` up to 240 characters, `authorId`, `kind`, `at`, `messageId`) and `mention` (`messageId`, `authorId`, `authorName`, `kind`, `at`, `preview`): the newest message
that names the caller, written by someone else, newer than the caller's own last message in the thread and at most `THREAD_MENTION_DAYS` old. A room word (`@channel`, `@here`) counts as a mention, as in the unread
count; a `#channel` link does not. The page is 50 rows, by cursor ("Show more threads").

`GET /api/teams/:slug/threads/counts` (read-only) answers `{ mentions }`, the number of threads that wait on the caller by the same rule, for the sidebar; it is driven by the caller's own mentions (cost follows what they were mentioned in, not the size of the team), and the sidebar reads it again on a relevant push, never on a plain navigation. The filter (`q`) folds case and accents on both sides as the page does, answers no `nextCursor`, and the list route keeps a ceiling of 120 reads a minute. The rows' work is read in three batches for the whole page, never per row:
`GET /api/thread-batch/runs?roots=a,b` (runtime-hermes: the runs going in those threads), `/api/thread-batch/todos` (tasks: the to-do lists) and `/api/thread-batch/approvals` (approvals: the pending questions),
at most 50 roots each (`THREAD_BATCH_MAX`); a thread the caller cannot read answers nothing, because the rows' own policies decide. All of them are `readOnly` routes. The client (`clients/web/src/inbox/`) keeps them live
with the pushes `run.started`, `run.ended`, `todo.changed` and `approval.changed` and a 20 second poll while the tab is visible (a run's own steps reach a person only through a lease the list does not hold).

### The thread's side rail: its files (P29-20)

`GET /api/threads/:rootId/files?limit=` (`readOnly`, `limit` 1 to 200, default 20) answers `{ items, total }`: the files attached to the messages of the thread, the root included, in the order of
their messages, the newest first (a message's own files keep their order). Each item is `{ file: { id, name, size, mime }, messageId, at, authorId, authorName, authorKind }`; `total` counts all of them, so
the rail can say "Show all files (60)". One SQL read joins `app.messages` (the root and `thread_root_id = root`, not deleted; `meta.attachments` unrolled) to `app.files`, and names the authors through
`app.message_authors`, so the rows' own policies decide: a thread of a channel the caller cannot read, and a file they cannot read, are left out, and an unreadable thread answers like one with no files.
A bot caller does not see voice clips (`audio/*`). The client is `clients/web/src/taskview/ThreadRail.tsx`: it reads this once when the rail opens and again only when a message with a file appears or goes
(the key is the ids of the messages that carry files), never per message.

## Manifest

`threads` / `0.1.0` / `server`, `dependsOn: ['channels']`, no extension points, no events (the read-state events of follow changes are the kernel's `reading.state.changed`).

## Tests

`test/threads.test.ts` (membership of each tab, ordering and cursor, follow semantics, the mirror, GET thread, guests, privacy, the thread's files), `e2e/api/threads/inbox.spec.ts`
(`pnpm e2e --project=api`), `e2e/runs/threads-view.spec.ts` (the view in a browser, P29-18), `e2e/runs/thread-rail.spec.ts` (the side rail, P29-21), `packages/plugins/channels/test/rls/channels-plugin.test.ts` (trigger and mirror).
