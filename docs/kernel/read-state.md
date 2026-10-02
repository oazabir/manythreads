# Read state (kernel service, P3-03)

Who has read what: one row per person per channel or thread, kept by the kernel so that channels, threads, notifications and the
sidebar all agree. Plugins use it through `ctx.readState` (SDK); the browser through the `read-state` plugin's routes.

## Table `app.read_state` (migration 0013)

| Column | Meaning |
|---|---|
| `person_id` | the reader (`people.id`, not an actor id); FK to `people`, cascades |
| `target_type`, `target_id` | `channel` + channel id, or `thread` + the thread's root message id; no FK (the kernel owns neither) |
| `last_read_id` | message id the person has read up to (uuid v7 sorts by time, so "newer" is `id > last_read_id`); null before the first read |
| `unread_count` | messages newer than that, as the person would see them; maintained by the service |
| `followed` | the Threads inbox flag |

Primary key `(person_id, target_type, target_id)`. The hot filter, "what is unread for me", has the partial index
`read_state_unread (person_id, target_id) INCLUDE (target_type, unread_count) WHERE unread_count > 0`; the unread summary reads only that index.

RLS is policy **P**: a person reads and writes their own rows. Nobody else can read them (workspace admins included), and the
`findPerRowPolicyCalls` harness passes (the policy is `person_id = (SELECT app.person_id())`, evaluated once per statement). Other people's
counters move only through `app.read_state_bump(...)`, a `SECURITY DEFINER` function that checks the caller is an actor of the workspace, only
touches active members of that workspace, skips the author, never counts a message that is not newer than the read position, and only ever adds one.

## `ctx.readState`

```ts
onPosted(tx, { targetType, targetId, messageId, authorId, recipientPersonIds }): Promise<Array<ReadStateEntry & { personId }>>
markRead(tx, personId, { targetType, targetId }, upToMessageId, options?: { remaining?: number }): Promise<ReadStateEntry>
setFollowed(tx, personId, { targetType, targetId }, followed): Promise<ReadStateEntry>
get(tx, personId, targets[]): Promise<ReadStateEntry[]>          // one per target, in order; zeros when unknown
unreadSummary(tx, personId): Promise<UnreadSummary>              // { channels: [{channelId, unreadCount}], threads: {threadCount, unreadCount}, total }
registerCounter(targetType, (tx, { targetType, targetId }, afterMessageId) => Promise<number>): void
```

- **Posting.** The plugin that inserts a message works out who should see it (channel members, thread followers) and calls `onPosted` in the same
  transaction. The author (actor id or person id) is never a recipient; unknown or inactive people are ignored. One statement serves the whole list.
- **Reading.** `markRead` is monotonic: a position older than the stored one changes nothing and returns the current state. Otherwise
  `unread_count` becomes the number of newer messages: `options.remaining` if given, else the counter registered for the target type
  (the channels plugin registers both, `channel` and `thread`; it counts as the person, so RLS decides what counts).
  Without either, `markRead` throws `UnreadCounterMissingError` (the HTTP route answers 501). The row is locked (`FOR UPDATE`) while the count is taken, so
  a post that races a mark-read is counted exactly once: the posting transaction's bump waits for the lock and lands after the absolute set.
- **Who calls.** `markRead` and `setFollowed` write the person's own row: run them as that person (or the system actor).

## Event and live push

Every change that actually changed something emits **`reading.state.changed`** (schema v1; three segments because event types are
`domain.noun.verb`, so not `read_state.changed`) in the caller's transaction: `{ targetType, targetId, reason: 'posted' | 'read' | 'followed',
changes: [{ personId, lastReadId, unreadCount, followed }] }`. A post emits one event for all recipients. It carries no `teamId`, so only workspace admins read it from the event log.
The same change is pushed to each affected person's sockets as a WebSocket envelope `{ type: 'reading.state.changed', id, payload: { targetType,
targetId, lastReadId, unreadCount, followed, reason } }`. A rolled-back change emits and pushes nothing.

Push mechanics (`ctx.realtime.pushToPerson(tx, personId, type, payload)` is the general form, notifications will use it): `pg_notify` on
`manythreads_realtime` inside the transaction, so it goes out at commit and reaches every server replica; each replica writes to the sockets of
that person that are connected to it (`createRealtime`, started in `startServer`). `/ws` registers a socket for the signed-in person (session cookie on the upgrade request).
Payloads must stay under 7,000 bytes.

## HTTP (plugin `read-state`)

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/read-state?targets=channel:<id>,thread:<id>` | 1 to 100 targets | `{ states: [{ targetType, targetId, lastReadId, unreadCount, followed }] }` |
| `GET /api/read-state/summary` | | `UnreadSummary` |
| `POST /api/read-state/mark` | `{ targetType, targetId, upTo }` (strict) | the new entry |

All act on the caller's own rows. Bots have no read state (403).

## Tests

`packages/kernel/test/rls/read-state.test.ts` (increment rules, monotonic mark-read, two racing mark-reads, a post racing a mark-read, the `EXPLAIN` of the
unread query, Nadia cannot read or write Rafi's rows), `test/events/read-state.test.ts` (event contract), `test/transport/realtime.test.ts` (push),
`packages/plugins/read-state/test/api.test.ts` (routes and the socket), `e2e/api/read-state/`.
