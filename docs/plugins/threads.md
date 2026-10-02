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
| `GET /api/teams/:slug/threads?tab=followed\|unread\|mine&limit=&cursor=` | The Threads inbox, `Page<ThreadInboxItem>`: root id, channel, title, root author, `replyCount`, `lastReplyAt`, `followed`, `unreadCount`, `mine`. Newest reply first, keyset cursor (opaque; a bad one is 400). `limit` 1 to 100 (default 30). |

### The inbox tabs (criterion 4)

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

## Manifest

`threads` / `0.1.0` / `server`, `dependsOn: ['channels']`, no extension points, no events (the read-state events of follow changes are the kernel's `reading.state.changed`).

## Tests

`test/threads.test.ts` (membership of each tab, ordering and cursor, follow semantics, the mirror, GET thread, guests, privacy), `e2e/api/threads/inbox.spec.ts`
(`pnpm e2e --project=api`), `packages/plugins/channels/test/rls/channels-plugin.test.ts` (trigger and mirror).
