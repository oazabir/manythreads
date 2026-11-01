# reminders

Later: a person saves a message (or a thread's message) to come back to, with or without a time at which they are reminded (PLAN P14-04). Saved items are private to the person; a job
that runs every minute turns a reminder whose time has come into a notification. Code: `packages/plugins/reminders`. Schemas: `packages/shared/src/entities/later.ts`, `api/later`,
`events/reminders.reminder.due.ts`. The plugin `dependsOn` channels (it points at channels and messages, and asks which channels a person can read). It does not send anything itself: the
notifications plugin hears the `reminders.reminder.due` event and writes the notification (see [notifications.md](./notifications.md)). The second half of the plugin is the `/remind` command (below): reminders made of plain text, for yourself, another person or a channel. Not built: email and mobile push.

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

## /remind: reminders made of plain text (P14-04)

Later saves a message to come back to. `/remind` is the other kind: you write the words, a time and who it is for, and at that time the words arrive. Both kinds are called reminders in the page; they are
different tables (`later_items` for a saved message, `reminders` for a written one) and the Later tab lists only the first kind. **`/remind list` shows the written ones** (see below).

### What a person types

`/remind <who> <when> <what>` in any message box (channel, thread, direct message, bot conversation excepted: it has no commands).

| Who | Means |
|---|---|
| `me` | the person themself |
| `@person` | another person of the team, about the conversation the command is typed in (they must be able to read it, and so must you) |
| `#channel` | a message posted in that channel at the time (you must be able to post there then) |

| When (always "in" the person's own time zone, taken from the browser) | Example |
|---|---|
| a length of time | `in 20 minutes`, `in 2h`, `in 3 days`, `in 1 week` |
| a clock time today (a time that has already passed is refused: it does not roll to tomorrow) | `at 15:30`, `at 3pm`, `at 9:30am`, `at noon` |
| a day | `tomorrow`, `tomorrow at 9`, `monday`, `monday at 9am` (the **next** such weekday, never today), `next week` (9:00 next Monday) |
| a date | `on 2026-12-01 at 10:00` (a date alone means 9:00) |

The rest of the line is the text (one line, at most 500 characters). `/remind` or `/remind list` opens the list: the reminders waiting (with *Cancel*) and the ones finished in the last 30 days (sent, cancelled,
or refused, with the reason). Only the maker sees them; an admin does not.

**Nothing is guessed.** A time that is not one of the forms above, a past time, a time more than a year ahead, a bare hour from 1 to 7 that could be morning or evening (`at 5` is refused: write `at 5pm` or `at 17:00`; `at 9` is 9:00),
and a missing text are each refused with one sentence that says what to write instead; the text stays in the box. The parser (`packages/shared/src/commands/when.ts`, `remind.ts`) reads the line in
one pass: no model, no regular expression that can backtrack, linear in the length of the line (tests `expectLinear` hostile inputs). It works against a `now` passed in, so it is tested without a clock.

### Where it goes when it is due

The minute job `reminders.send_due` (send.ts, detached: a list, then a few short transactions per reminder) delivers each due reminder after checking the rights **again at that moment**:

- **For me**: a message in the person's own **Reminders** conversation, from a system sender named *Reminders*, reading `Reminder: <text>`; and a notification of type `reminder` (bell, live, browser alert). The Reminders
  conversation is a direct message with only that person in it and the key `reminders:<person id>`, made on first use by `app.reminders_inbox()`. It appears in the person's direct messages (named *Reminders*,
  not "Notes to self"). It is not pushed into the sidebar the moment it is made: it shows with the next refresh of the list (decision: a new conversation appearing by itself would be a surprise).
- **For a person**: the same, in **their** Reminders conversation, reading `Reminder from <maker>: <text>`. The maker is not notified of the delivery.
- **For a channel**: a message from *Reminders* in the channel, reading `Reminder from <maker>: <text>`. It carries no mention and no link (`skipRefs` on the message provider), so it pings nobody; the channel's own
  notification rules apply as for any message.
- **Refused at the time**: if the maker can no longer post in the channel, or can no longer read the conversation a person-reminder was about, or the person can no longer read it, nothing is delivered. The row
  becomes `refused` with a plain reason (shown in the list) and the maker gets a message in their Reminders conversation: `Your reminder “<text>” was not sent. <reason>`. A database error is retried (three tries, and not
  after 24 hours), then refused with a general sentence.
- Notification rules: a reminder **bypasses a muted channel and the level "nothing"** (the person asked for it) and **honours Do not disturb** (held and delivered when it ends). The normal "new message" notification is
  suppressed for messages in a `reminders:` conversation, so the person gets one notification, not two (`notifications` consumers). The notification carries the Reminders sender's name.
- **Guests have no reminders** (a guest's reach is the channels they were granted; there is no place to deliver to). The page hides nothing: `/remind` shows disabled with "Guests cannot set reminders." and the
  server refuses with 409.

### Who may remind whom

The creator can post in a channel to remind it; to remind a person, **both** can read the conversation (checked when it is made, by `app.reminders_target_ok`, and again at the time). A person who cannot see a
channel cannot be probed through it (the function answers false for a channel the caller cannot read). Budget per maker, counted in the database under an advisory lock per person (so two requests at once cannot
both slip under): **100 waiting** in all, **20 waiting for other people or channels**, **10 waiting for one person**, **30 made for others in an hour**. Over a limit, a sentence says which.
What one person can be sent is capped too, from all makers together: **20 waiting for one person**. Other makers' rows are hidden from the maker by row-level security, so the count is read through a definer
function (`app.reminders_pending_for(person)`, owned by the system role, which the table's system policy lets read every row); the maker and the recipient are locked together in sorted order, so two makers at
once cannot both slip under and no two requests can wait on each other. The refusal is the sentence "That person already has many reminders waiting. Try again later." (a reminder for yourself is not counted).
The text of a reminder made by someone else is delivered as plain words: it is put inside a code span (`plainCodeSpan` in `packages/shared/src/commands/remind.ts`), so it shows no link, mention or emphasis and the
link-preview plugin, which skips code, fetches nothing from it. A maker name that looks like markup is wrapped the same way. Your own `me` reminders stay ordinary text. Routes: `POST /api/reminders`
30 per minute, the others 120 per minute (process memory, like the other plugins). A reminder is at most 366 days ahead.

### Tables (migration `0002`)

`reminders` (row-level security, kind **P**): `creator_id`, `target_kind` (`me`, `person`, `channel`), `target_person_id`, `channel_id` (the conversation the person was asked in, or the channel to post in; cascade), `text` (one
line, 1 to 500 characters), `remind_at`, `state` (`pending`, `sent`, `cancelled`, `refused`), `refused_reason`, `sent_message_id` (no foreign key), `sent_at`, `attempts`, times. Checks tie the target columns to the kind, the
reason to `refused`, `sent_at` to `sent`. Policies: the system role has `FOR ALL` (its own policy: the role is not BYPASSRLS); a person **selects only their own** rows (the person a reminder is for never reads it, an admin
neither), **inserts** only as themself, `pending`, in their workspace, for a channel they can read (`me`/`person`) or post in (`channel`) (hoisted `visible_channel_ids`), and **updates** only a waiting own row to
`cancelled` (`reminders_guard` allows nothing else to a person). `reminders_before_insert` (a person's rights and the budget above; the system role is let through, its fixtures are not a person's budget). Note the order
Postgres uses: a BEFORE INSERT trigger runs before the policy's WITH CHECK, and WITH CHECK runs before table CHECK constraints, so which error a bad row gets depends on that order.
`reminder_senders` (system only): one `actor` of kind `system` per workspace, made on first use by `app.reminders_act_as()` (system role only; it switches the transaction's `app.actor_id` to the sender, the way
the webhooks plugin does). Functions: `reminders_act_as`, `reminders_inbox(person)`, `reminders_target_ok`, `reminders_pending_for(person)`. Migration `0002` also replaces `app.message_authors` (the **fourth** time: it names the sender *Reminders*, on
top of the webhooks version), which is why the manifest `dependsOn` `webhooks` (and through it `bots`): the migrations must run after the last one that replaced it.

### Routes

| Method and path | What it does |
|---|---|
| `GET /api/reminders?state=pending\|history` | `{ items, pendingCount }`. Pending: soonest first. History: sent, cancelled and refused of the last 30 days, newest first. Each item has the target (person or channel name, or null when the caller can no longer read it), `text`, `remindAt`, `state`, `refusedReason`. |
| `POST /api/reminders` | `{ target, text, remindAt }` (strict; `target` is `{kind:'me'}`, `{kind:'person', personId, channelId}` or `{kind:'channel', channelId}`). 201 with the reminder. 400 bad input or a time that is past or too far ahead; 401; 403 a place the caller cannot use; 409 a guest, a limit or a person who cannot read the place. |
| `DELETE /api/reminders/:reminderId` | Cancels a waiting reminder: `{ cancelled: true }`; already sent or cancelled: `{ cancelled: false }`; not the caller's: 404. |

### Events

`reminders.reminder.changed` (v1): `{ workspaceId, reminderId, creatorId, targetKind, recipientId, change: created | cancelled | sent | refused }`. Ids only: no text, no time, no reason (the log is readable by admins). No
consumer. The delivery of a `me` or `person` reminder also writes `reminders.reminder.due` (the same event as Later, with the posted message and the Reminders conversation as the anchor), which the notifications plugin
turns into the notification.

### Jobs

`reminders.send_due`: every minute, detached, one at a time per process, at most 100 per run within a 45-second budget; removes finished reminders older than 30 days. `reminders.fire_due` (Later, above) is unchanged.

### Decisions to know

- Why a Reminders conversation and a sender, rather than only a notification: a notification is anchored to a message in this product, and a message is what the person can open, scroll back and quote. The notification
  is created from the message; the conversation is the person's history of what they asked for.
- Not built: a reminder that repeats; `/remind` for a team; editing a waiting reminder (cancel and make a new one); email and mobile push.

## Manifest

`reminders` / `0.1.0` / `server`, `dependsOn: ['channels', 'webhooks']`, `extends: ['event.emit', 'job.register']`, emits `reminders.reminder.due` and `reminders.reminder.changed`, consumes nothing.

## Tests

`test/later-api.test.ts` (save, list order and counts, privacy, times, the 200 limit, refusals, deleted message and lost channel, firing once, a mention and a reminder on one message, Do not disturb,
level "nothing"), `test/rls/later-rls.test.ts` (harness, owner-only access, the insert rule, the update guard, the cap, the system role), `test/events/reminders-events.test.ts`,
`test/rls/reminders-rls.test.ts` and `test/remind-api.test.ts` (`/remind`: making, rights, budget, the cap on what one person is sent, plain-text delivery, cancelling, delivery to self, a person and a channel, the rights check at the time), `packages/shared/test/when.test.ts`, `remind-actions.test.ts`, `slash-commands.test.ts` (the parser, with hostile linear-time inputs), `packages/shared/test/later.test.ts`, `test/events/phase14-reminders-contracts.test.ts`, `test/events/phase14-reminders-changed-contracts.test.ts`, `clients/web/test/later.test.ts` (preset times, custom time, the client copy), `clients/web/test/slash.test.ts` and `slash-run.test.ts` (planning and running `/remind`), `e2e/channels/later.spec.ts`
(desktop and phone), `e2e/channels/reminders.spec.ts` (`/remind`, the list and Cancel; delivery is tested in the database test, not waited for). Live screenshots: `e2e/screens/task.p14-04.shots.ts` (not part of `pnpm e2e`).
