# notifications

The inbox behind the bell (SPEC section 3, PLAN P3-09; wireframe "Notifications popover" in PLAN phase 3 section 2). Code: `packages/plugins/notifications`. Schemas:
`packages/shared/src/entities/notification.ts`, `api/notifications`, `events/notifications.notification.created.ts`. The plugin `dependsOn` channels (it reads channels, messages and
thread follows, and its inbox policy probes the channel visibility set). The browser permission flow ("Allow browser alerts?") is a client concern (`clients/web/src/notifications/`: the bell, the popover, and the row that asks the browser and saves the
`browser` flag through `PUT /prefs`; it is absent where there is no Notification API): this plugin stores the `browser` flag per kind and hands it to the client with every live push.

## What makes a notification

Four kinds, each made by a subscription of the plugin's outbox consumer (it runs as the system actor, once per event, in one transaction with its effects):

| Event | Kind | Who is told |
|---|---|---|
| `channel.mention.created` | `mention` | the mentioned person (people only, not bots). A role group (`@on-call`, P14-03) is expanded by the channels plugin into one event per holder who can read the channel, so each holder is told as for a direct mention: the author is left out, a person named twice is told once, and the person's level for the channel, the per-kind switch and Do not disturb apply. This plugin has no group logic of its own |
| `channel.message.posted` in a **direct message** (or group conversation) | `dm` | every other member |
| `channel.message.posted` as a **reply** in a team channel's thread | `reply` | the followers of the thread (`app.thread_follower_ids`) |
| `reminders.reminder.due` | `reminder` | the person who asked to be reminded (see below) |
| `channel.message.deleted` | | the message's notifications are deleted (`message` and `reminder` rows) |
| `channel.member.removed` | | if the person can no longer read the channel (private channel, DM), what it notified them of is deleted |

A plain channel message notifies nobody unless the person chose **All messages** for that channel or the message holds one of their **keywords** (next section). Bot conversations notify nobody yet.

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

## Levels, keywords and browser push (P14-09, migration `0003`)

**Levels.** Each person can say, per channel, what may interrupt them: `all` (every message), `mentions` (a mention, one of their keywords, a reply in a thread they follow) or `nothing`. The workspace has
a default for team channels (`mentions` until an admin changes it); a direct message starts at `all`. `levelAllows` in `packages/shared/src/entities/notification-level.ts` is the one rule:

| Level | Kinds that make a row |
|---|---|
| `all` | `mention`, `reply`, `dm`, `message` |
| `mentions` | `mention`, `reply` (a direct message needs `all`, so choosing `mentions` for a DM mutes its plain messages) |
| `nothing` | none, not even a mention. `channel_members.muted` and the old `mutedChannels` setting still mean `nothing` |

The consumer reads the levels in the same transaction as it writes the rows, so a change applies from the next message. The held-by-Do-not-disturb path (P14-01) is unchanged: a row a level allows is
held while DnD is on and announced on release; a row a level refuses is never made.
The screens that set Do not disturb (pause, schedule, status) and the paused mark on the bell are the presence plugin's: [presence.md](./presence.md).

**New kind `message`**: any message in a channel the person has joined, only at level `all`. It follows the `dm` entry of the settings document (`prefKey`), so the three switches are unchanged. It is the
weakest kind in the upsert rank, so a mention, a reply or a keyword on the same message replaces it.

**Keywords.** A person keeps up to 20 words or phrases (a phrase is at most 4 words, 40 characters). They are stored lower-case with single spaces. A message matches when the keyword appears as whole words,
ignoring case and accents-as-written (NFKC): `deploy` matches "Deploy!" and "(deploy)" but not "deployment". The matching reads the first 20,000 characters of the message in a single pass (`matchKeywords`),
and the database only offers the keywords whose first word occurs in the message (`first_word` index), so a long message or a long list stays cheap. A match is a `mention` row with the `keyword` column
set (the inbox says "wrote 'outage'"); a real @mention of the person on the same message wins over the keyword. Keywords count only in channels the person has **joined** and can read, and in their direct messages; the
author never matches their own words.

**Tables.** `notification_levels` (RLS **P**: person and channel, a person may only set a level for a channel they can read), `notification_workspace_settings` (RLS **W**: any member reads the default,
only owners and admins write it), `notification_keywords` (RLS **P**), `push_subscriptions` (RLS **P**: a person reads and deletes their own; subscribing goes through the definer function
`app.notifications_push_subscribe`, which moves a browser to the caller if someone else used it before). `notifications.keyword` is new, and the kind check allows `message`.

**Routes** (all for the caller; a bot gets 403):

| Method and path | What it does |
|---|---|
| `GET /api/notifications/levels` | `{ workspaceDefault, channels: [{ channelId, channelName, channelKind, level }] }`: the levels the person set themself |
| `PUT /api/notifications/levels/:channelId` | `{ level }` or `{ level: null }` to follow the default again; 403 for a channel the person cannot read |
| `PUT /api/notifications/workspace-level` | `{ level }`, owners and admins only |
| `GET`, `PUT /api/notifications/keywords` | `{ keywords }`; `PUT` replaces the list and answers 400 with a sentence for a keyword it refuses |
| `GET /api/notifications/push` | `{ available, publicKey, subscriptions }`: whether the server can push, the public key to subscribe with, and how many browsers the person has signed up |
| `POST /api/notifications/push/subscribe`, `.../unsubscribe` | the browser's `endpoint` and keys (`p256dh`, `auth`); 409 when the server has no signing key |

**Browser push.** Web Push with VAPID (RFC 8030, 8291, 8292), written with `node:crypto` only (`src/webpush.ts`; the RFC 8291 test vector is in `test/webpush.test.ts`). `announce()` enqueues one detached job
`notifications.push` per signed-up person; the job sends nothing if the row was read or held in the meantime, if the person can no longer read the channel, or if Do not disturb is on now. A push service answering
404 or 410 removes the subscription; other failures retry up to four times.

- **What the push says.** The title names the sender, and the channel only for a public team channel. The body is the message preview **only for a public team channel**; for a private channel, a direct message or a group conversation neither the channel name nor the text is sent: the body is
  always "Open manythreads to read it." (`buildPushPayload`, tested). The link is `/open?channel=<id>&message=<id>[&root=<id>]`, ids only.
- **Where it may go.** The endpoint must be https on port 443 with no user name, at a known push service (`fcm.googleapis.com`, `android.googleapis.com`, `push.services.mozilla.com`, `push.apple.com`,
  `notify.windows.com`). Add more with `MANYTHREADS_PUSH_HOSTS` (comma-separated host suffixes). Redirects are not followed; a send waits at most 8 seconds.
- **The key.** `MANYTHREADS_VAPID_PRIVATE_KEY` is a P-256 private key in PEM; the public key is derived from it. Helm generates one on first install and keeps it in the server secret (`vapid-private-key`, like the
  metrics token); to make one by hand for compose: `openssl ecparam -name prime256v1 -genkey -noout`. `MANYTHREADS_VAPID_SUBJECT` (default: the public URL) is the contact the push services see. With no key, push is
  switched off and the settings screen says so. Do not replace the key on a running site: every browser would have to sign up again.
- **The service worker** `/sw.js` (`clients/web/public/sw.js`, served with `Cache-Control: no-cache`) shows the notification unless a tab of the site is visible and focused, and opens `/open?...` on a click
  (in the open tab if there is one). It caches nothing.
- **Shared computers.** The signed-in browser is taken off push before it signs out, and a browser that signs up under another person is moved to that person.

**Where people find it.** Account settings, section Notifications: what tells you (mentions, replies, direct messages), the default for team channels (admins change it), the channels they set themself, the
keywords, and this browser (alerts while open, push). In a channel, the bell in the header sets that channel's level.

**Not done.** The sidebar's unread dots following the level (P14-15), and a delivery check against a real push service (only the encryption and the request are tested here).

## Email digest (P14-09 and P14-09b, migration `0005`)

A person who has been away for a while and still has unread mentions, replies or direct messages gets **one** email that lists them, sent through the system mailer (the one that sends password resets and
invitations; set `MANYTHREADS_SMTP_URL`, see [docs/deploy](../deploy.md)). Every mail ends with a link that turns the digest off in one click.

**Who and when.**

| Rule | What happens |
|---|---|
| On or off | A person with no setting has the digest **on**. It needs a verified email address that is the one they sign in with, so a bot, and anyone without one, gets nothing. |
| Away | The presence plugin's heartbeat is older than the person's delay (30 minutes to 24 hours, default 1 hour), or there is none. Asked through the `presence` provider (`PresenceProvider` in the SDK), not by reading the table: the job fetches the people of the workspace seen within the last 24 hours (`seenSince`) and hands them to the candidate query, so only people who are away are ever read, and people at their desk cost nothing per minute. Without the presence plugin nothing is sent. |
| No mail server | When `MANYTHREADS_SMTP_URL` is not set (`ctx.mail.configured` is false) the job does nothing: no watermark moves and no "sent" record is written, so the digests are not swallowed by a mailer that sends nothing. One log line says so for the whole process, with no address in it. The settings say the digest is not available on this server. |
| Restart of the heartbeat data | The heartbeat table is UNLOGGED, so a database crash empties it and every tab looks away until its next beat (30 seconds). The presence provider keeps a marker (`warmSince`, table `presence_epoch`, also UNLOGGED, so it vanishes in the same crash); the job sends nothing until that marker is 5 minutes old. A fresh install waits 5 minutes after the first run, too. |
| What is listed | Unread `mention`, `reply` and `dm` notifications that arrived after the last digest (first digest: the last 24 hours; never older than 7 days). Rows held by Do not disturb are not listed, and a person with any held row waits until they are delivered. |
| Still allowed | Checked again when the mail is made: the channel is one the person can still read (a private channel or direct message they left gives nothing), the channel is not muted, its level (or the workspace default) still allows the kind, and the per-kind switch in Notifications is on. Do not disturb that is on **now** sends nothing. The digest never lists what the app would not have told the person about. |
| Never twice | One digest per person per delay. The last-digest time (the watermark) is moved in a transaction of its own per person, before the mail, so a second run, or a second server, finds nothing to do; if the mailer fails or takes longer than 45 seconds it is put back and the next minute tries again. A mail that was handed to the mailer is not repeated (at most once): if writing the audit record fails afterwards, the claim stays and a warning is logged. The mail server connection itself gives up after 20 seconds of silence (`SMTP_TIMEOUT_MS`). |
| Everything read | Nothing is sent. |
| Turned back on | Switching the digest on again starts a fresh window (a trigger moves the watermark to now), so what piled up while it was off is not mailed. |

**What the mail says.** Subject "N new messages for you" (N counts what arrived since the last digest and is still unread, not everything the person has unread). The text of each item is read from the message when the mail is made, so an edit shows and a deleted message is left out. At most **10** items, mentions first, then direct messages, then replies, the newest first within each kind, grouped by channel or conversation; each
has the sender, the place (`#channel` or "Direct message"), an excerpt of at most 140 characters on one line (control characters, direction marks and zero-width characters removed, markup escaped in the HTML part) and a
link to the message (`/open?channel=…&message=…`, ids only). More than 10 shows "and N more". The footer says "at most one email every <delay>" (the person's own delay), and has the unsubscribe link and a link to the settings.

**The job.** `notifications.digest`, every minute (`* * * * *`), detached (it holds no transaction while it talks to the mail server), one workspace at a time, at most 200 people per round and 5 rounds per run. A run that stops at that cap remembers the last person it reached (in the server process) and the next run carries on after them, wrapping round at the end, so nobody with a higher id is starved by people who stay candidates without a mail to send.
Every workspace and every person is isolated: claim, mail and record are separate steps per person, each in its own try/catch; an error is logged without an address or any text and the run goes on. A run that finds nobody away is one presence query and one candidate query per workspace (the candidate query starts from the workspace's people and reads notifications through the unread index). Who can read a channel is asked once per channel per run (`channel_audience`), not once per item. There is no per-item mail: the digest is the only mail this plugin sends.

**Table** `notification_digest` (migration `0005`, RLS **P**): `person_id` (key), `enabled`, `delay_minutes` (CHECK 30 to 1440), `last_digest_at`, `unsubscribe_key`. A person has the defaults until a row exists (made when they
change a setting or when the first digest is claimed). Column grants let the person role read and write `enabled` and `delay_minutes` only: it cannot read `unsubscribe_key` and cannot move the watermark. Rows are
never deleted by a person, because the key must not change.

**The unsubscribe link.** `https://<site>/api/notifications/digest/unsubscribe/<token>` with `token = v1.<person id>.<base64url HMAC-SHA256>`. The MAC is over the person's id with the person's own random
`unsubscribe_key`, made once and never changed. There is no clock in it, so an old mail's link works as long as the person exists, and no deployment secret has to stay the same. It names one person and can do one thing: turn that person's digest off. The path
starts with `/api/` because that is what the web server proxies without a sign-in. The mail also carries `List-Unsubscribe: <that link>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so
mail programs offer their own "Unsubscribe" button, which sends the POST.

- `GET` shows a small page "Stop these emails?" with one button and **changes nothing**: link scanners and previews open links, and must not unsubscribe anyone. If the digest is already off it shows "You will no longer get these emails" with "Turn them back on", a link to Account → Notifications.
- `POST` (the button, or a mail program's one-click POST, with or without a session and CSRF token) turns the digest off and answers the same page, or `{ "unsubscribed": true }` to a client that does not ask for HTML. It can be repeated. The event is written once.
- A token that is malformed, signed with another key, names another person or an unknown person answers 404 with a plain page and the same words for each case.
- 30 requests a minute per client address. This is not in the abuse limits table because it is not a credential route: a token is a 256-bit MAC and cannot be guessed.
- The page is server-written HTML with no script, `Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

**Settings routes** (the caller; a bot gets 403): `GET /api/notifications/digest` → `{ enabled, delayMinutes, emailAvailable, mailConfigured, lastSentAt }`; `PUT /api/notifications/digest` with `{ enabled, delayMinutes }` (400 with a sentence for a delay outside 30 to 1440 minutes).
Account → Notifications has the section **Email me what I missed**: a switch, and "How long away" (30 minutes, 1, 2, 4, 8, 24 hours). With no verified address it says so and explains why nothing is sent; when the server has no mail server (`mailConfigured` false) it says the digest is not available on this server and the controls are off. While a change is saved the controls keep keyboard focus (`aria-busy`, not `disabled`) and a polite status line says "Saved." or why it failed.

**Events** (v1, both in the audit log, neither with a message or an address): `notifications.digest.sent` `{ personId, itemCount, shownCount, channelCount }` (audit: "Sent an email digest", category system; one row a person
a digest, so a large workspace adds up: watch the audit volume) and `notifications.digest.unsubscribed` `{ personId, via: 'link' | 'settings' }` (audit: "Turned off the email digest", category settings). The job and the
route are the only writers.

**Known limits.** The mail is plain English (no translations yet). It is sent from the address in `MANYTHREADS_MAIL_FROM`; for the one-click unsubscribe to count with large mailbox providers the sending domain needs SPF and
DKIM like any other bulk mail. The local e2e stack has no mail catcher, so `e2e/notifications/email-digest.spec.ts` runs a small SMTP server of its own.

## Reminders (P14-04, migration `0004`)

The reminders plugin ([reminders.md](./reminders.md)) emits `reminders.reminder.due` when a person's saved message is due; this plugin turns it into a notification of kind **`reminder`**
(`deliverReminder` in `src/service.ts`). Because the person asked for it, a reminder is **not** held back by the channel's level (even "nothing"), the per-kind switch or a muted channel, and the author
is not excluded (you can remind yourself of your own message). It still needs the person to be able to read the channel (checked again against `app.channel_audience`) and it is **held by Do not
disturb** like the rest, then released when it ends. Its `ref_type` is `reminder` (migration `0004` widens the kind and ref-type checks) with `ref_id` the message, so a mention and a reminder on one
message are two rows. The row is re-armed (unread, new time) only if the earlier reminder was read; an event delivered twice announces nothing the second time. The browser-alert flag follows the
mention setting; the push title is "Reminder" plus the place. Tests: `packages/plugins/reminders/test/later-api.test.ts`.

**`/remind` (P14-04).** A written reminder that comes due for a person is delivered as a message from the *Reminders* sender in the person's own Reminders conversation (a direct message with the key
`reminders:<person id>`), and the reminders plugin emits the same `reminders.reminder.due` event with that message as the anchor, so the notification above is the only one: **the normal new-message path
ignores a message in a `reminders:` conversation** (`consumers.ts`: it would otherwise notify a second time, honour the conversation's mute and read the text for keywords). The notification names the author
*Reminders* (`systemAuthorName` in `service.ts` knows the webhook names and the Reminders sender). A reminder for a channel is an ordinary message there, with no mention and no link, notified by the channel's
own rules. See [reminders.md](./reminders.md).

## Manifest

`notifications` / `0.1.0` / `server`, `dependsOn: ['channels', 'presence']`, `extends: ['event.emit', 'event.subscribe', 'job.register']` (the jobs `notifications.release_held`, `notifications.push` and `notifications.digest`), emits
`notifications.notification.created`, `notifications.digest.sent`, `notifications.digest.unsubscribed`, consumes `channel.mention.created`,
`channel.message.posted`, `channel.message.deleted`, `channel.member.removed`, `presence.dnd.changed`, `reminders.reminder.due`.

## Tests

`test/notifications-api.test.ts` (mention for the target only, private-channel and forged-event cases, removal and deletion cleanup, replies and follows, DMs, muting and settings, paging and mark-read,
live push, replay), `test/rls/notifications-rls.test.ts` (harness, visibility, write refusals, the update guard, the upsert rank, prefs), `test/events/notifications-events.test.ts`,
`test/prefs.test.ts`, `test/levels-keywords-push.test.ts` (levels, keywords, DnD, push end to end with a stand-in push service), `test/webpush.test.ts` (encryption, signing, endpoint rules, payload privacy), `packages/shared/test/notification-level.test.ts`, `clients/web/test/notification-settings.test.ts` (settings rules and the service worker), `e2e/api/notifications/inbox.spec.ts` (`pnpm e2e --project=api`).
The email digest (P14-09): `test/digest-plan.test.ts` (planning, caps, escaping, the mail and its headers, the signed token), `test/digest-isolation.test.ts` (no mail server, a failing audit write, a failing claim, a hung mail server, edited and deleted messages, the restart of the heartbeat data, only-away reading and the cursor), `test/digest.test.ts` (database-backed: who gets a mail and who does not, the window, Do not disturb, lost access, a failing mailer, the settings routes, the unsubscribe link), the digest cases in `test/rls/notifications-rls.test.ts` and `test/events/notifications-events.test.ts`, `packages/plugins/presence/test/provider.test.ts`, `packages/kernel/test/mail.test.ts` (the headers), and `e2e/notifications/email-digest.spec.ts` (a real mail into a small SMTP server of its own, the one-click link, Account).
