# P36-04..07 · The team schedule

Owner, 2026-11-23: "a schedule feature on the sidebar that shows a Google Calendar-like calendar with all the scheduled meetings there and any other schedule
task for the team. Each team will have its one common schedule. If a user belongs to multiple teams, the user schedule view should show a combined
appointment list from all the teams. A team member can create a new appointment after selecting the team where it will be created and then invite people
across multiple teams into that appointment. The appointment can be a voice meeting or a full video call meeting."

## 1. An appointment

`app.appointments`: the team it belongs to (its common schedule), a title, a start and an end (at most 24 hours), audio or video, an optional agenda line, who
made it, `scheduled` or `cancelled`, and **its meeting space** (P36-03): a team-less private channel of kind `meeting` opened when the appointment is made,
whose members are the maker and the invited (from any team, at most 100). The space is where its call card, its chat before and after, its notes and
transcript live, and what its notifications point at; Join starts (or joins) the call there. `app.appointment_invitees` lists the invited.

The P16-05 planned rooms (`app.scheduled_meetings`, a channel's room with a Google or Microsoft calendar event) stay as they are and are shown in the
calendar beside the appointments of the same team.

**Who sees what.** Every member of the team sees the team's appointments (the common schedule); an invited person of another team sees the ones they are
invited to; a guest sees none. The maker, a lead of the team and a workspace admin may change or cancel one.

## 2. Routes (meetings plugin)

- `GET /api/appointments?from&to` — every appointment the person may see in the window, across all their teams, with the team (slug, name), the invited,
  the space, and the call live in it; plus the planned rooms of their teams in the same window (marked as such).
- `POST /api/teams/:slug/appointments {title, startsAt, endsAt, kind, inviteeIds, agenda}` — opens the space, writes the appointment, tells the invited.
- `PATCH /api/appointments/:id` (title, time, kind, agenda, invitees: added people join the space and are told; removed ones leave it), `POST …/cancel`.
- `POST /api/appointments/:id/join` — the call in its space, started with the appointment's kind or joined when live.

## 3. Notifications

Two new kinds in the notifications plugin, `appointment_invite` ("Nadia invited you to Design review · Tue 14:00") and `appointment_soon` ("Design review
starts in 5 minutes"), reference type `appointment`, channel = the space; one row per person and appointment, Do not disturb holds them, the browser push as
for the other kinds; opening one goes to the space. The reminder job runs every minute (`reminded_at` once; a moved time reminds again).

## 4. The Schedule screen

A sidebar item **Schedule** (`/t/:team/schedule`): a calendar with Day, Week (default) and Month views, today marked and a line at the current time; each of
the person's teams in its own colour with a filter chip per team; an appointment block shows its title, time and a video mark; the planned rooms of P16-05
in the same colours, outlined. Opening one shows a panel: title, team, time, audio/video, agenda, the invited, Join (from ten minutes before until it ends),
and for the maker Edit and Cancel. **New appointment**: team (of the person's teams), title, day, start and end, audio or video, agenda, people from any
team (the P36-03 search). At 390 px the week becomes a day list.

## 5. Steps

1. P36-04 data, routes and tests (RLS: a member, an invited person of another team, someone not invited, a guest).
2. P36-06 New appointment and the notifications (invite).
3. P36-05 the Schedule screen.
4. P36-07 the reminder and Join; a browser test end to end (Nadia schedules with Sameera, Sameera sees it in her Schedule, both join at the time).
