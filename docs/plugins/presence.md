# presence

Who is here and what a person says about themself: the heartbeat that says active or away, a custom status, a time zone with working hours, an out-of-office note, and **Do not disturb**
(a pause, a switch, or a weekly quiet-hours schedule that makes the notifications plugin hold what would interrupt the person). Code: `packages/plugins/presence`. Schemas:
`packages/shared/src/entities/presence.ts`, `entities/presence-time.ts` (the clock rules, shared by the server and the browser), `api/presence`, `events/presence.dnd.changed.ts`.
The plugin `dependsOn` channels (the heartbeat table `app.presence` is channels' migration `0003`; this plugin owns its routes). The notifications plugin
([notifications.md](./notifications.md)) reads the Do not disturb settings and hears `presence.dnd.changed`; the two never import each other.

## What a person sees

All of it is in the web client; a server without this plugin answers 404 and the app draws none of it.

- **Account menu** (the gear at the foot of the sidebar): *Set status…*, *Pause notifications…* (the label reads *Notifications are paused…* while a pause is on) and *Do not disturb settings*.
  The person's status emoji shows beside their name in the foot.
- **Set status** (a dialog): an emoji (typed, or one of ten quick ones), up to 100 characters of words, *Clear after* (*Don't clear*, *30 minutes*, *1 hour*, *4 hours*, *Today* = this device's next
  midnight; editing a status that already has a clear time also offers *Keep the current time*), five ready-made statuses (*In a meeting*, *Commuting*, *Working remotely*, *Out sick*, *On holiday*)
  and *Clear status*. A status needs an emoji or some words. A cleared or expired status is simply not served.
- **Pause notifications** (a dialog, and a block of the account page): *30 minutes*, *1 hour*, *Until tomorrow morning* (9:00 the next day on this device's clock), *Until I turn it off*, and a day and
  time of the person's own (*Pause until then*; in the past or more than 7 days away is refused in words). Each ready-made choice shows the time it ends. A ready-made or custom pause also
  switches a hand-set Do not disturb off, so the pause's end is what shows.
- **While Do not disturb is on** three things show it: the bell carries a small moon and its name reads *Notifications, paused until 15:30*; the bell's popover starts with
  *Paused until 15:30 · Resume now*; and a line above the account row in the sidebar says the same. A pause ends on its own on time (the client works the state out from the saved settings with
  `dndState`, so it needs no request at the end). *Resume now* ends a pause or a hand-set Do not disturb. **Quiet hours** (the weekly schedule) say *Quiet hours until tomorrow 07:00* with *Change*
  (to the schedule) instead of *Resume now*: the schedule has no "skip tonight". One polite live region in the shell (outside the sidebar, so it also works while the phone's drawer is closed) says
  the paused sentence aloud when it begins.
- **Held notifications.** The popover and the account page say so: *Notifications that arrive meanwhile are kept back and delivered together when it ends, within about a minute.* This is the
  notifications plugin's behaviour, not new: a notification written while Do not disturb is on carries `held_at` and is hidden from the inbox, the unread count, the live push and the browser push; when
  the pause ends the `notifications.release_held` job (every minute) or the `presence.dnd.changed` consumer (when the person turns it off by hand) clears `held_at` and announces the rows together
  (`src/hold.ts` in the notifications plugin). A reminder is held the same way.
- **Account → Status and Do not disturb** (`/account#status-and-dnd`): the status editor; the pause choices; a **weekly schedule** (a switch, then per weekday a checkbox with *From* and *To*
  times; an end earlier than the start runs overnight into the next morning, the row says so; the first time it is switched on every day starts at 22:00 to 07:00; days with the same hours are
  saved as one period); and **Time zone and working hours** (a zone list that starts from this device's zone and shows the local time there, working days as chips, *From*, *To*). The schedule is read in the saved
  time zone. If none is saved, saving the schedule first saves this device's zone, so the hours mean what the screen says (the server would otherwise read a schedule in UTC).

- **Dots beside names** (P14-01c). A dot says *Active* (filled green), *Away* (half-filled amber) or *Offline* (an empty grey ring), so the three differ by shape as well as colour (the ring and marks reach 3:1
  on the page and on the selected sidebar row; the app has no dark theme yet). A custom status adds its emoji: the first picture of it only, and nothing when the emoji field holds text. The tooltip and
  accessible name say it in words (*Active, In a meeting*, plus *Out of office*), so a list option that contains a dot has them in its name. It shows beside a person's name in the team roster (*People*), the
  member panel, the @ mention picker, the author of a message and the row of a one-to-one conversation in the sidebar. **Never beside a bot or a webhook**: the roster lists people only, a bot has no
  heartbeat, and a bot's availability keeps its own look. `PresenceDot` (`clients/web/src/presence/PresenceDot.tsx`) reads only its own person's card; the shell, the settings pages and the account page share one heartbeat loop and fetches every card in
  one request every 30 seconds (`useHeartbeat`), so a row never asks the server. **Nothing is drawn until the cards have arrived** (`cardsLoaded`: an unknown answer is not "Offline"), none while the last
  three rounds failed (the old cards are kept but not shown as live), none on a server without the plugin, and **for a guest none beside anybody but themself** (the server serves a guest only their own
  card). Who can be seen is the server's rule (`GET /api/presence/people`): a member sees the people of the workspace, so everything a person writes into their profile is visible to the whole workspace, and the
  screens say so (*Everyone in the workspace can see this.*).
- **Rounds and tabs.** A visible tab sends the beat and reads the cards and the person's own settings every 30 seconds (that is what keeps a pause made on another device fresh; there is no second timer). A
  hidden tab sends only the beat. Only one tab of a browser may say *away* while another is in use: a tab in use takes a lease in `localStorage` (75 s) on each beat and the others stay quiet
  (`tabLease.ts`; without storage each tab beats for itself). A 404 from the presence routes means "no plugin" and is asked again after five minutes; a 403, a 500 or a dropped connection is just a failed
  round. Only the newest round's answer is applied, and none after another person signs in (`reset`).
- **Profile card.** Pressing a person's name or avatar (message author, roster) opens their card: Active / Away / Offline, status, **local time** in their zone (*Karachi (UTC+5)*) and how it compares with
  yours (*5 h ahead of you*), working hours with *Working hours now* or *Outside working hours now*, and, while they are away, *Out of office* with the day they are back, the note and *Ask <delegate>
  meanwhile* (the delegate's name is shown when the reader's team list has it, else *Ask a colleague meanwhile*). The words come from `src/presence/profileModel.ts` (pure, tested). A person who shared nothing gets a line that says so.
- **Account → Out of office** (in `/account#status-and-dnd`): a switch, *First day back* (after today in the person's own zone), *Ask meanwhile* (the people of your teams) and a note of up to 200 characters.
  The form says which zone the day is read in and, when none is saved, saves this device's zone first (like the hours editor); it shows a note saved elsewhere until something is typed. Saving sends `outOfOffice` through `PATCH /api/presence/me` (`src/presence/oooModel.ts` builds and checks the request); switching it off clears the whole note; the server ends it by itself on the return day.

Not built: a `/status` or `/dnd` slash command, calendar sync, a dot beside the sidebar's channel members or a "who is here" list in a channel (there is no channel member list in the app yet), a dot in the
workspace-members settings page, a *Message* button on the profile card, out-of-office shown beside names in the DM picker, and the approvals routing that reads the delegate (P18-03). A schedule that was
written through the API with two periods on one day is shown with one period per day (the first) and a note says so before it is saved over.

## Tables

`person_status` (rls: workspace — members read everyone of the workspace, a guest only themself; a person writes only their own row): `person_id` PK, status emoji / text / `status_clears_at`,
`time_zone`, `working_hours` jsonb, out-of-office fields. `dnd_settings` (rls: person — **forced** row-level security, a person reads and writes only their own row; the system role reads it to
hold and release): `person_id` PK, `enabled`, `paused_until`, `schedule` jsonb. Migration `0001_presence.sql`. The heartbeat is `app.presence` (UNLOGGED, channels `0003`): expires by itself,
because readers filter by `seen_at` (90 s).

## Routes

| Route | Does |
|---|---|
| `POST /api/presence` `{ status? }`, `GET /api/presence` | The heartbeat (`online`, the default, or `away`; one every 30 s per open tab) and who has beaten in the last 90 s. 120 per minute. |
| `GET /api/presence/people` | A card for each person the caller may see: heartbeat state, live status, time zone, working hours, live out-of-office note. Do not disturb is **not** in a card. 120 per minute. |
| `GET /api/presence/me` | The caller's own settings in full, including `dnd` and `dndState` (on or off now, why, until when). The web client reads it on load, every minute and when the tab is shown again. |
| `PATCH /api/presence/me` | Strict body; a field left out stays, `null` clears. `status` (past clear time refused), `timeZone`, `workingHours` (needs a time zone), `outOfOffice`. A changed time zone writes `presence.dnd.changed`. 60 per minute. |
| `PUT /api/presence/dnd` | Strict body: `enabled`, `pauseMinutes` (1 to 10 080, `null` ends a pause), `schedule` (up to 7 periods). Always writes `presence.dnd.changed`. 60 per minute. |

Errors come from the closed set: 400 `validation_failed` (the reason is a plain sentence), 403 `forbidden` for a bot, 429 `rate_limited`.

## Event

`presence.dnd.changed` (v1): `{ workspaceId, personId, active, until }`. No settings and no text. The notifications plugin releases what it held when `active` is false.

## Manifest

`presence` / `0.1.0` / `server`, `dependsOn: ['channels']`, `extends: ['event.emit', 'provider.presence']`, emits `presence.dnd.changed`, consumes nothing.

**The `presence` provider (P14-09).** `ctx.providers.get<PresenceProvider>('presence')` (extension point `provider.presence`, `PresenceProvider` in the SDK): `lastSeen(tx, personIds)` answers, as the transaction's actor, when each person's latest heartbeat arrived (people who never sent one are absent from the map). It is how the notifications plugin's email digest decides who has been away, without reading `app.presence` itself. Read-only; it takes no `extends` to use. Test: `test/provider.test.ts`.

## Tests

`packages/plugins/presence/test/presence-api.test.ts`, `test/rls/presence-rls.test.ts`, `test/events/presence-events.test.ts`; `packages/shared/test/presence.test.ts` (clock rules) and
`test/events/phase14-presence-contracts.test.ts`; `clients/web/test/presence-profile.test.ts` (dot words, unknown zones, emoji, zone label, tab lease, colour contrast, local time and offset, profile facts, the out-of-office form, card identity across refreshes) and `test/presence-store.test.ts` (known vs unknown cards, failed rounds, 403 and 404, overlapping rounds, reset, hidden tab); `clients/web/test/presence-settings.test.ts` (pauses and their ends, the paused words, the schedule rows against the server's own reading, status,
zone and hours, the client copy of the settings); `e2e/channels/status-dnd.spec.ts` (desktop and phone). Live screenshots: `e2e/screens/task.p14-01b.shots.ts` (not part of `pnpm e2e`).
