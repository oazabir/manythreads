# notifications

The inbox behind the bell (SPEC section 3, PLAN P3-09; wireframe "Notifications popover" in PLAN phase 3 section 2). Code: `packages/plugins/notifications`. Schemas:
`packages/shared/src/entities/notification.ts`, `api/notifications`, `events/notifications.notification.created.ts`. The plugin `dependsOn` channels (it reads channels, messages and
thread follows, and its inbox policy probes the channel visibility set). The browser permission flow ("Allow browser alerts?") is a client concern (`clients/web/src/notifications/`: the bell, the popover, and the row that asks the browser and saves the
`browser` flag through `PUT /prefs`; it is absent where there is no Notification API): this plugin stores the `browser` flag per kind and hands it to the client with every live push.

## What makes a notification

Three kinds, each made by a subscription of the plugin's outbox consumer (it runs as the system actor, once per event, in one transaction with its effects):

| Event | Kind | Who is told |
|---|---|---|
| `channel.mention.created` | `mention` | the mentioned person (people only, not bots) |
| `channel.message.posted` in a **direct message** (or group conversation) | `dm` | every other member |
| `channel.message.posted` as a **reply** in a team channel's thread | `reply` | the followers of the thread (`app.thread_follower_ids`) |
| `channel.message.deleted` | | the message's notifications are deleted |
| `channel.member.removed` | | if the person can no longer read the channel (private channel, DM), what it notified them of is deleted |

A plain channel message notifies nobody (a mention has its own event). Bot conversations notify nobody yet.

Left out, always: the **author** (own actions), anyone who **cannot read the channel** (checked again against `app.channel_audience`, so an old or forged event cannot leak), anyone who turned
that kind's `inApp` off, anyone who **muted the channel** (`channel_members.muted`, or the channel in their settings' `mutedChannels`).

**One row per message and person.** `(person_id, ref_type, ref_id)` is unique and the consumer upserts, writing only when the row is new or the new kind is stronger
(`mention` > `reply` > `dm`). So a reply that also names a follower is one `mention`, whichever of the two events is handled first, and an event delivered twice (the outbox is at least
once; the host also dedupes with `processedOnce`) writes nothing, pushes nothing and emits nothing the second time. Test: `test/notifications-api.test.ts` replays an event with its processed marker removed.

## Tables (migration `0001`)

`notifications` (RLS **P**): `id` (uuid v7), `workspace_id`, `person_id` (FK people), `kind`, `ref_type` (`message`), `ref_id` (the message), `channel_id` (FK channels, cascade), `thread_root_id`,
`actor_id`, `actor_name` (snapshot), `preview` (plain text, one line, at most 140 characters, snapshot), `read_at`, `created_at`. Indexes: unique `(person_id, ref_type, ref_id)`;
`(person_id, id DESC)`; partial `(person_id, id DESC) WHERE read_at IS NULL`; `(ref_type, ref_id)`; `(channel_id)`; BRIN `(created_at)`.

`notification_prefs` (RLS **P**): `person_id` PK, `workspace_id`, `prefs jsonb` (an object), `updated_at`.

Policies: the system role has `FOR ALL` (it writes and deletes). A person **reads** their own rows **only while they can read the channel** (`person_id = person AND channel_id = ANY (visible_channel_ids('read'))`,
both hoisted, so no per-row function call: `findPerRowPolicyCalls` passes), and **updates** their own rows, but a trigger lets a non-system update change `read_at` only, and never clear it. Nobody
but the system inserts or deletes a notification. Prefs: a person reads, inserts and updates their own document; the system reads them. Tests: `test/rls/notifications-rls.test.ts`.

## Routes

| Method and path | What it does |
|---|---|
| `GET /api/notifications?limit=&cursor=&unread=` | `Page<Notification>`, newest first, keyset by id (`nextCursor` is the last id of the page, a bad cursor is 400). `limit` 1 to 100 (default 30). `unread=true` lists unread only. A notification carries `kind`, `refId` (the message), `channelId`, `channelName` (null for a DM), `channelKind`, `threadRootId` (open the thread panel when set), `actorName`, `preview`, `readAt`, `createdAt`. |
| `GET /api/notifications/summary` | `{ unreadCount }`, counted as the caller (only what they can still read). |
| `POST /api/notifications/mark-read` | `{ ids: [1..100 ids] }` or `{ all: true }` (strict, one of the two). Answers `{ updated, unreadCount }`. Ids that are not yours or already read are skipped. 300 per minute. |
| `GET /api/notifications/prefs`, `PUT /api/notifications/prefs` | The settings document (defaults until saved). `PUT` replaces the whole document (strict; send what `GET` returned, changed), folds duplicate muted channels, at most 500 of them. 60 per minute. |

All act on the caller's own rows; a bot has no inbox (403), no session is 401.

### Settings document

```json
{ "mention": { "inApp": true, "browser": false }, "reply": { ... }, "dm": { ... }, "mutedChannels": ["<channel id>"] }
```

`inApp: false` for a kind means no row is made for it. `browser` is read by the web client: when a `notification.created` push arrives with `browser: true` the client raises an operating-system
alert (after the person allowed them in the browser; the permission prompt and the "Allow browser alerts?" row of the popover set it through `PUT`). Browser alerts therefore ride on the in-app
notification. A stored document written by another version is made whole with defaults (`normalizePrefs`), never an error.

## Live push

Through `ctx.realtime.pushToPerson` (WebSocket envelope `{ type, id, payload }`, delivered at commit on every replica):

| Type | Payload | When |
|---|---|---|
| `notification.created` | `{ notification, browser }` (`NotificationCreatedPush`) | a row was written, and also when a reply or dm became a mention: **upsert by `notification.id`**; a new id raises the badge by one, `GET /summary` is the authoritative count |
| `notification.read` | `{ ids, all, unreadCount }` (`NotificationReadPush`) | the person marked some or all read (their other tabs and devices drop the badge) |

## Event

`notifications.notification.created` (v1, `NotificationsNotificationCreatedEvent`): `{ notificationId, personId, kind, refType, refId, channelId, actorId }`, written as the system actor when a row is
written or raised. No `teamId` (so only workspace admins and the system read it from the log) and no text. Mobile push and mail channels (phase 11) subscribe to it. Test: `test/events/notifications-events.test.ts`.

## Manifest

`notifications` / `0.1.0` / `server`, `dependsOn: ['channels']`, `extends: ['event.emit', 'event.subscribe']`, emits `notifications.notification.created`, consumes `channel.mention.created`,
`channel.message.posted`, `channel.message.deleted`, `channel.member.removed`.

## Tests

`test/notifications-api.test.ts` (mention for the target only, private-channel and forged-event cases, removal and deletion cleanup, replies and follows, DMs, muting and settings, paging and mark-read,
live push, replay), `test/rls/notifications-rls.test.ts` (harness, visibility, write refusals, the update guard, the upsert rank, prefs), `test/events/notifications-events.test.ts`,
`test/prefs.test.ts`, `e2e/api/notifications/inbox.spec.ts` (`pnpm e2e --project=api`).
