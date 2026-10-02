# direct-messages

Get-or-create a private conversation between two or more people, and list mine (SPEC section 6.1, PLAN P3-06, criterion 5). Code: `packages/plugins/direct-messages`. Schemas:
`packages/shared/src/api/dm`. A DM is a row of the channels plugin's `channels` table with `kind = 'dm'`: reading and posting use the ordinary channel routes with the DM's channel id,
threads, reactions, unread, mentions and pushes work unchanged. This plugin owns the one door that creates one.

## Get-or-create in one statement

`app.dms_get_or_create(person_ids uuid[]) -> (channel_id, created)` (migration `0001`, `SECURITY DEFINER`, owned by `manythreads_system`; the channels policy never lets a caller insert a
DM) adds the caller to the set, sorts and de-duplicates the ids and builds `dm_key` (`id1,id2,...`, unique per workspace in `channels_dm_key`). Then one data-modifying statement:

```sql
WITH ch AS (INSERT INTO app.channels ... VALUES (<pre-drawn id>, ..., 'dm', true, <dm_key>)
            ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm' DO SELECT RETURNING id),
     members AS (INSERT INTO app.channel_members SELECT ch.id, <each person> FROM ch ON CONFLICT DO NOTHING)
SELECT id FROM ch;
```

so the channel and its members exist together or not at all, and `created` is "the returned id is the one drawn". Concurrent opens of one pair queue on the unique index: the winner inserts, the
others `DO SELECT` the winner's row (ten at once, from both sides, make one row: `dm.test.ts`, `rls/dms.test.ts`, `e2e/api/dm/get-or-create.spec.ts`). Inside a definer function `app.is_system()`
is always true, so the function checks the caller with `app.lookup_workspace_role()` and the actor row.

Who may be in a DM: the caller and every other person must be an **active, non-guest member of the caller's workspace**. A guest cannot open a DM (403) and cannot be named in one (400), a bot
is not a person (403), an unknown, suspended or other-workspace person is 400. One to eight other people (a conversation holds at most nine). Opening a DM with only yourself is allowed (notes to self).

## Privacy

Only the people in a DM see it: `channel_members` is the membership, and a **workspace admin who is not a participant** cannot read the channel, its members or its messages (the channels
visibility rule, `docs/plugins/channels.md`), nor add themselves (`channels_add_member` refuses a DM). A DM cannot be left. `GET /api/dms` of an admin lists only the DMs they are in.

## Routes

| Method and path | What it does |
|---|---|
| `POST /api/dms` `{ personIds }` | `{ dm, created }`: 201 when this call made the conversation, 200 when it existed. `dm` is a `DirectMessageSummary`: `channel` (kind `dm`, `dmKey`, no team, name `''`), `participants` (including the caller, by display name), `lastMessage` (id, author, a 140-character preview, time; null before the first), `unreadCount` (the caller's). Events and pushes only on creation (below). 60 per minute. |
| `GET /api/dms?limit=&cursor=` | My conversations, most recently active first (the latest top-level message, else the creation of the channel; both uuid v7, so they sort by time), same shape, `limit` 1 to 200 (default 50), `cursor` is the `nextCursor` of the page before. |

On creation: `channel.channel.created` (kind `dm`, private, `teamId: null`, as the opener) and a `channel.created` socket push `{ channel }` to every other participant so the conversation appears
in their sidebar. Opening again emits and pushes nothing.

## Manifest

`direct-messages` / `0.1.0` / `server`, `extends: ['event.emit']`, emits `channel.channel.created`, `dependsOn: ['channels']`, migrations `migrations`.

## Tests

`test/dm.test.ts` (get-or-create, concurrency, groups, refusals, privacy, the list), `test/rls/dms.test.ts` (`pnpm test:rls`: the function's guards, no direct write, admin sees nothing, concurrency),
`test/events/dm-events.test.ts` (`pnpm test:events`), `e2e/api/dm/get-or-create.spec.ts` (`pnpm e2e --project=api`).
