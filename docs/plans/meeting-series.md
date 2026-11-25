# Meeting series: recurring meetings with a live agenda (P17-05)

Row: P17-05. Plugins `packages/plugins/meetings` (the series, its occurrences, the agenda job), `packages/plugins/pages` (the live editor opens an agenda),
`packages/plugins/repo-git` (people may edit an agenda under `meetings/`), `packages/plugins/files` (the Files tree offers it), web `clients/web/src/screens/schedule`.
A **series** is a meeting that repeats on a simple rule. Each meeting of it, an **occurrence**, is an ordinary appointment of the team schedule (P36-04).

## Findings that shape the plan
- The native schedule is P36-04's appointments (`0010_appointments.sql`, `routes-appointments.ts`, the Schedule screen). P16-05's planned rooms need a Google or Microsoft
  calendar, so a series is built on appointments, not on them.
- Each appointment opens its own meeting space (a team-less private channel, P36-03), and `appointments.space_channel_id` is UNIQUE. A space per occurrence would put
  a dozen "Meetings" in the sidebar: **a series has one space**, shared by its occurrences. The UNIQUE goes; a partial unique index keeps one space per single appointment.
- A call in a meeting space has `team_id` NULL, so the Scribe never writes its notes ("A direct-message call has no team"). Action items from notes are rare there:
  the agenda itself must hold them. The agenda page gets an **Action items** checklist; a box not ticked is open. Items from written notes are added when they exist.
- `meetings/` in a team repo is written only by the platform: the repo writer refuses everyone else (`isMeetingsPath`, `repo.ts`), and the kernel's path guard refuses
  bots (`GUARDED_REPO_DIRS`). A live page is only under `pages/` (`PagePath`, `live.ts`). People editing an agenda under `meetings/series/<slug>/` needs one narrow
  exception in the writer, the live socket and the Files tree: **a person who may post in the team may change an agenda file that already exists** (no create, delete or
  rename; bots still refused).
- The occurrence rows are written by people (create, under row-level security) and by a job (top-up, as the system role); `agenda_path` is a path the system role later
  writes to. A person must never set it: a trigger keeps `series_id`, `occurrence`, `agenda_path`, `agenda_written_at`, the space and the team unchanged except by the
  system role, and the job checks the path's shape before it writes.
- Notes of a meeting space are read only by its members, while the team repo is read by everyone on the team: carrying action items into the agenda copies them to the
  team. Said in the form; Personal notes (a note-taker's organizer copy) are never carried.
- A weekly meeting at 10:00 must stay at 10:00 across daylight saving: occurrences are computed in the series' time zone, in SQL
  (`(local start + k * step) AT TIME ZONE tz`; a month step from the first date keeps the 31st as the last day of a shorter month).

## What a person sees
- **New appointment** (`AppointmentForm.tsx`) gains **Repeats**: Does not repeat (default), Every week, Every 2 weeks, Every month; with a repeat, **Until** (optional
  date) and one line: "Each meeting gets an agenda page in Engineering's files that everyone on Engineering can read and edit. Open action items from the last meeting are
  copied into the next agenda." Create sends the series request.
- The calendar shows every occurrence as today's appointments do, with a repeat mark (`SeriesIcon`, ProIcons ArrowSync) on the block.
- **The panel** of an occurrence: "Repeats · Every week until 31 March"; **Agenda**: **Open the agenda** (from the moment it is written), or "The agenda opens after
  the meeting before it", or for a person of another team "The agenda is kept in the team's files". The maker, a lead or an admin also gets **Stop the series**
  (asks once: "Stop Weekly sync? The meetings still to come are cancelled. Agendas already written stay.").
- **Open the agenda**: a wide dialog with the live editor (`LivePageEditor`: everyone's cursor, saved by itself when people leave or after a minute of quiet), titled
  with the date. Done closes it.
- **Edit** of an occurrence changes that meeting only (title, time, call kind, agenda line); its people are the series' and are changed for the whole series (the form
  says so and saves them through the series).
- **Phone (390 px)**: the form's Repeats and Until stack in one column; the agenda dialog is full screen with the editor filling it; no horizontal scroll.

## The agenda page
`meetings/series/<slug>/<yyyy-mm-dd>-agenda.md` (the date in the series' time zone; `-2` if a moved meeting lands on a day already used), and `README.md` of the folder
(title, rule, team), both written by the platform:

```
# Weekly sync · Tuesday 1 December 2026

## Agenda
-

## Open action items from the last meeting
- [ ] Send the draft to legal — Priya

## Action items
*Tick an item when it is done. Items not ticked are copied into the next meeting's agenda.*

## Notes
```
- **When**: the first occurrence's agenda as soon as the series is made; each later one once the meeting before it has ended (its end time plus one hour, and no call
  live in the space), and in any case one hour before it starts. A cancelled occurrence gets none; the next one carries from the last agenda written.
- **Carry-over**: every box not ticked under the two action-item headings of the last agenda, plus the action items of the notes of the last call held in the space
  since that agenda's meeting began (status written, not Personal), each once (same text, case and spaces folded), at most 50, each one line of at most 300 characters,
  Markdown escaped. The parse is one linear pass over lines (no nested regex quantifiers), code fences skipped.

## Data (`meetings/0013_meeting_series.sql`; Zod and mapper in the same diff)
- `app.meeting_series (id, workspace_id, team_id cascade, space_channel_id UNIQUE cascade, slug CHECK '^[a-z0-9]+(-[a-z0-9]+)*$' ≤ 48 UNIQUE (team_id, slug), title 1–120,
  agenda ≤ 2000, kind audio|video, frequency weekly|biweekly|monthly, time_zone 1–64 (checked by Postgres), first_starts_at, duration_minutes 1–1440, until_date date null,
  status active|stopped, created_by, created_by_person_id, created_at, updated_at, stopped_at)`. RLS forced: read by the team's members and the space's members (visibility
  sets); insert by a member of the team for a space they opened; update by its maker, a lead or an admin; a guard trigger keeps every column but title, agenda, status,
  stopped_at and updated_at for the system role, and status moves only active → stopped.
- `app.appointments` gains `series_id` (cascade), `occurrence int`, `agenda_path`, `agenda_written_at`; UNIQUE (series_id, occurrence); `space_channel_id` loses UNIQUE
  (a partial unique index where `series_id IS NULL`, a plain index for the FK). The insert policy also requires `agenda_path` and `agenda_written_at` empty and a series of
  the caller's own with the same team and space; trigger `appointments_series_guard` keeps the series columns, the space and the team for the system role on update.
  Definer `app.appointment_space_ok(space, series)` (system role owns it): a space serves one appointment or one series.
- Shared enums `MeetingSeriesFrequency`, `MeetingSeriesStatus` + `ENUM_COLUMNS`.

## API (`packages/shared/src/api/meetings/series.ts`; schema-compat snapshots for each)
- `POST /api/teams/:slug/meeting-series` (strict: the appointment fields + `frequency`, `untilDate?`, `timeZone`) → 201 `{ series, appointment }` (the first occurrence).
  Opens the space (`app.meetings_open_space`), writes the series and its occurrences for the next 92 days with their invited, tells the invited once (the first
  occurrence's `meetings.appointment.changed`), enqueues the agenda job. 20 a minute.
- `PATCH /api/meeting-series/:id` `{ title?, inviteeIds? }` → `{ series }`: the meetings still to come take the title and the people; the space follows. 30 a minute.
- `POST /api/meeting-series/:id/stop` → `{ series }`: the meetings after now are cancelled.
- `Appointment` gains `series: { id, title, frequency, untilDate, status } | null` and `agendaPath: string | null` (null until written, and for a person who cannot
  see the team). An occurrence's `PATCH …/appointments/:id` with `inviteeIds` is 409 "Change the people for the whole series"; its title does not rename the space.
- Pages: the live socket takes `LivePagePath` (`pages/…` or an agenda path, `isSeriesAgendaPath` in `repo-paths.ts`, exact and lower case).

## Jobs
- `meetings.series-plan` (cron every 10 min, system): per active series, add the occurrences up to 92 days ahead (copying the people of its latest occurrence) and enqueue
  `meetings.series-agenda` for each series whose next agenda is due.
- `meetings.series-agenda` (`serialKey: seriesId`): writes the README when missing and the due agenda, through the repo as the system actor, then sets `agenda_path`.

## Events and audit
`meetings.series.changed` v1 `{ workspaceId, teamId, seriesId, change: created|changed|stopped, changedBy, at }` (ids only, never a title). Audit mapper: "meeting
series made / changed / stopped". Contract test in the events suite.

## Tests
- Unit (`series-agenda.test.ts`): open items of an agenda (ticked, unticked, outside the two headings, in a code fence, duplicates, long lines, hostile Markdown),
  render, timing rule.
- Routes through the real server (`series.test.ts`): a weekly series in `Europe/Berlin` across the March change keeps 10:00 local; every 2 weeks; monthly from the 31st;
  until; the invited on each occurrence and one space; members, the invited of another team and an outsider; occurrence invitees refused; series people and title; stop;
  the agenda job writes README and the first agenda; a person edits an agenda through the repo, cannot create, delete or write another file under `meetings/`; the
  second agenda carries the unticked item and the notes' item, not the ticked one, not a Personal note's.
- RLS (`meetings-series-rls.test.ts`): reads by member, invited, outsider, guest; the maker cannot set `agenda_path` or move an occurrence to another series; a series
  pointing at someone else's space is refused; direct column changes refused.
- Pages: the live socket opens an agenda path and commits it as the person.
- Web: the request builder and repeat label; e2e `e2e/meetings/series.spec.ts` (Nadia makes a weekly series, sees next week's occurrence, opens the agenda and types; the
  panel at 390 px).

## Order of work
1. Shared (paths, schemas, event), migration, routes, jobs, the writer, live socket and tree exceptions; tests.
2. Web: the form's Repeats, the panel's series line, agenda and Stop, the agenda dialog; e2e.
3. Step 2 (built, `0016_series_changes.sql`): change a series' rule or time, an occurrence moved by a later rule change, notes written after the next agenda are added
   to it, the agenda readable by invited people of other teams, reminders that link the agenda. See "Step 2" below.

## Step 2
- **A new rule or time**: `PATCH /api/meeting-series/:id` takes `frequency`, `untilDate`, `timeZone`, `startsAt` and `endsAt` (together), `fromAppointmentId`. The meetings
  still to come from that meeting on (the next one when absent) are deleted and planned again from the new rule with the series' people, the first at `startsAt` (that
  meeting's own time when absent). A meeting moved or cancelled one at a time among them is made again: the new rule wins. A meeting that has begun stays. The numbers
  of the new meetings follow the last one kept, and `meeting_series.rule_from` names the rule's first, so the planner's formula is `first_starts_at` plus
  (k − rule_from) steps (`app.meeting_series_start`, shared by `app.meeting_series_plan` and `app.meeting_series_change_rule`). An agenda already written for a deleted
  meeting moves to the first new one (its file keeps its name). The definer checks the caller itself (maker, lead, admin) with `app.meeting_series_can_edit`.
- **The form**: Edit of a meeting of a series: "This meeting" (as in step 1) or "This and the following meetings" (Repeats without "Does not repeat", Until; Call and
  Agenda line hidden, they are one meeting's): "This meeting and the ones after it are made again from the new time and repeat. A meeting changed or cancelled on its own
  among them is made again too. Agendas already written stay."
- **Notes after the next agenda**: `meetings.notes.written` for a series' space enqueues the agenda job; the planner's pass also does when the last call before the next
  written agenda has notes it did not take in. The job adds the items not on the page (ticked or not, same folding as carry-over) under "Open action items from the last
  meeting" (or a new such section at the end), commits with the blob it read as base, and records the call (`appointments.agenda_notes_meeting_id`, kept the platform's by
  the guard trigger): once per call, so an item a person deleted stays deleted. It waits while the page has a live cursor (`page_awareness`) or unsaved live edits
  (`page_updates` after `page_docs.last_update_id`). The live editor starts from the file, not its saved session, when the two differ.
- **The agenda for the invited of other teams**: `Appointment.hasAgenda`; `GET /api/appointments/:id/agenda` → `{ path, markdown, truncated, editable }` for anyone who
  sees the meeting (row-level security on appointments), read from the team repo by the platform; 404 for anyone else and before a page is written. The panel offers
  **Read the agenda** (a read-only view) where the team gets **Open the agenda**. The form's line now says the people invited can read it.
- **Reminders**: the five-minute reminder of a meeting with its agenda written says "<title> starts in 5 minutes. The agenda is ready."; opening it (app or push) goes to
  `/schedule?appointment=<id>`: the meeting's panel, with Join and the agenda. `GET /api/appointments/:id` serves that.
- Tests: `series-changes.test.ts` (routes), `meetings-series-rls.test.ts` (the definer and the new column), `series-agenda.test.ts` (adding items), pages `live.test.ts`
  (a page changed outside), notifications `webpush.test.ts` (the push link), web `schedule-series.test.ts`.
- Not built: telling people that a series' time changed; changing a series' call kind or agenda line for all its meetings.

## Decisions taken (recommended defaults; the owner may change them)
1. A series is a recurring appointment of the team schedule; one meeting space for the whole series (one chat, one Files folder for its transcripts).
2. Rules: every week, every 2 weeks, every month (same day of the month, the last day when shorter); an optional end date; meetings are planned 92 days ahead.
3. The agenda lives in the team repo under `meetings/series/<slug>/`, readable and editable by everyone on the team; people invited from other teams read it through
   the meeting (step 2), and do not edit it.
4. Open action items are the unticked boxes of the last agenda plus the action items of the last call's written notes; Personal notes are never copied.
5. People edit an agenda that exists; only the platform creates agendas, and nobody deletes or renames them.
6. Editing one meeting of a series changes that meeting only; people and title are changed for the whole series; stopping cancels the meetings still to come.
7. (Step 2) A new rule re-makes the meetings to come from a chosen meeting, including ones changed one at a time; the invited are not notified of the new times.
