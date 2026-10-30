# reminders

Later: a person saves a message (or a thread's message) to come back to, with or without a time at which they are reminded (PLAN P14-04). Saved items are private to the person; a job
that runs every minute turns a reminder whose time has come into a notification. Code: `packages/plugins/reminders`. Schemas: `packages/shared/src/entities/later.ts`, `api/later`,
`events/reminders.reminder.due.ts`. The plugin `dependsOn` channels (it points at channels and messages, and asks which channels a person can read). It does not send anything itself: the
notifications plugin hears the `reminders.reminder.due` event and writes the notification (see [notifications.md](./notifications.md)). Not built here: the `/remind` slash command, email and mobile push.

## What a person sees

- **On a message** (More menu, in a channel or a thread): *Mark for later* (no time), *Remind me…* with *In 20 minutes*, *In 1 hour*, *Tomorrow morning* (9:00 the next day), *Next week* (9:00 next Monday,
  never today) and *Pick a date and time…*. A saved message offers *Remove from Later*, a message with a reminder offers *Change reminder…*. The times are worked out in the browser in the person's own
  time zone and sent as an exact moment; the server never guesses a zone.
- **The Later tab** of Threads (next to Followed, Unread and Mine): the open items with the author, the channel, a one-line snippet and when the reminder is due or when it was saved. Reminders that are
  due sit at the top under *Due now*, and the tab shows how many. Selecting an item shows the message with *Open message* (opens it in its channel or thread), *Mark done*, *Remove*, and a way to
  move the reminder (*Remind me again*, *Clear the reminder*). *Done* lists the finished items, with *Move back to To do*. The list refreshes every 30 seconds and when the tab comes back into view.
- **The bell.** A due reminder arrives as a notification titled *Reminder* with the message's author and snippet, in the bell, live in open tabs, and as a browser alert for people who turned those on.

## Tables (migration `0001`)

`later_items` (row-level security, kind **P**: each row belongs to one person): `id` (uuid v7), `workspace_id`, `person_id` (FK people), `message_id`, `channel_id` (FK channels, cascade), `thread_root_id`, `state` (`open` or `done`), `remind_at`, `fired_at`,
`done_at`, `created_at`, `updated_at`. A check ties `state = 'done'` to `done_at` being set. Indexes: unique `(person_id, message_id)` (saving a message again changes its reminder, it never adds a
row), `(person_id, state, id DESC)`, channel, workspace, message, and a partial `(remind_at) WHERE state = 'open' AND fired_at IS NULL AND remind_at IS NOT NULL` that holds the job's whole working set.

The row holds **ids and times, never any text of the message.** `message_id` has no foreign key on purpose: when retention removes a message for good the item stays and says so.

Policies: the system role has `FOR ALL` (the job reads and updates every row). A person reads, updates and deletes **only their own** rows (an admin included). A person inserts only for themself, in their
workspace, and only for a channel they can read (`channel_id = ANY (visible_channel_ids('read'))`, hoisted, so `findPerRowPolicyCalls` passes). Two triggers: `later_items_guard` lets a person change
only `state`, `done_at`, `remind_at`, `fired_at` and `updated_at`; `later_items_cap` refuses the 201st item of a person (under an advisory lock per person, so two requests at once cannot both slip
past) with "You already have 200 saved items. Finish or remove some first."

## Routes

| Method and path | What it does |
|---|---|
| `GET /api/later?state=open\|done` | `{ items, openCount, dueCount }`. Open: due items first (oldest reminder first), then the rest newest first. Done: latest finished first. Each item has `state`, `remindAt`, `due`, `createdAt`, `doneAt` and `message` (author, one-line snippet of at most 200 characters, channel, thread root, time) **or `null`** when the message is gone or the caller can no longer read its channel. 120 per minute. |
| `PUT /api/later/messages/:messageId` | Saves the message, body `{ remindAt?: iso \| null }` (strict). New item: 201. Already saved: 200, the item is reopened; a given `remindAt` (null clears it) replaces the reminder and lets it fire again, an omitted one keeps the old. 400 for a bad time, 403 for a message the caller cannot see, 404 for a deleted one, 409 when the person has 200 open items (a full list drops its oldest finished item to make room). 60 per minute. |
| `PATCH /api/later/items/:itemId` | `{ state: 'open' \| 'done' }`. 404 for an item that is not the caller's. 120 per minute. |
| `DELETE /api/later/items/:itemId` | Removes the item. 404 for an item that is not the caller's. 120 per minute. |

A bot has no list (403), no session is 401. Rate limits live in process memory like the others.

**Times** (`checkRemindAt` in `packages/shared`, used by the server and by the client's custom-time field): a time up to a minute in the past counts as now (clock slack); anything older is refused with
"That time has already passed. Choose a later one."; more than a year ahead is refused with "Reminders can be set at most a year ahead."

## The minute job

`reminders.fire_due` runs every minute (`* * * * *`, so a reminder is at most a minute late; the same job mechanism as the rhythms tick). In one transaction it takes the due rows with
`FOR UPDATE SKIP LOCKED` (two replicas cannot take the same row), sets `fired_at`, and writes one `reminders.reminder.due` event for each item whose message still exists. Items whose message is
gone are marked fired and announced to **nobody**. Whether the person can still read the channel is **not** checked here: a cron job has no workspace in its transaction, which the audience
function needs, so the notifications plugin checks it when it handles the event (see below). `fired_at` and the event are written together, so a reminder is announced **once**: a second run finds
nothing, and moving the reminder (or saving it again with a new time) clears `fired_at` so the new time fires. A reminder whose time passed while the server was down fires on the next run.

## Event

`reminders.reminder.due` (v1, `RemindersReminderDueEvent`): `{ workspaceId, personId, itemId, messageId, channelId }`. No text and no `teamId`, so only workspace admins and the system read it from the
log. The notifications plugin consumes it.

## No leak of a message the person lost

The list reads the message **as the caller, every time** (row-level security on messages and channels), so a deleted message or a channel the person left shows "This message is no longer available" with
the id and times only: no author, no channel name, no words. The job announces only messages that still exist; the notifications consumer re-checks the audience (`app.channel_audience`, the list of people who can read the channel), so a person who lost the channel gets an event of ids and no notification. The notification itself disappears with its message (the deleted
consumer removes `reminder` rows too) and, being a notification, with the person's access to the channel (its select policy). A person can still mark such an item done or remove it.

## Manifest

`reminders` / `0.1.0` / `server`, `dependsOn: ['channels']`, `extends: ['event.emit', 'job.register']`, emits `reminders.reminder.due`, consumes nothing.

## Tests

`test/later-api.test.ts` (save, list order and counts, privacy, times, the 200 limit, refusals, deleted message and lost channel, firing once, a mention and a reminder on one message, Do not disturb,
level "nothing"), `test/rls/later-rls.test.ts` (harness, owner-only access, the insert rule, the update guard, the cap, the system role), `test/events/reminders-events.test.ts`,
`packages/shared/test/later.test.ts` and `test/events/phase14-reminders-contracts.test.ts`, `clients/web/test/later.test.ts` (preset times, custom time, the client copy), `e2e/channels/later.spec.ts`
(desktop and phone). Live screenshots: `e2e/screens/task.p14-04.shots.ts` (not part of `pnpm e2e`).
