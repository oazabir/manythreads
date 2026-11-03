# meetings

Voice rooms (PLAN P15-01 to P15-03): a person starts a voice room in a channel, others join, and the room ends when someone ends it or two minutes after the last person left. This is the backend:
rooms, who is in them, the routes, the jobs, the events. The web room (P15-04), live captions and transcription (P15-05 onward) are not built. Code: `packages/plugins/meetings`. Schemas:
`packages/shared/src/entities/meeting.ts`, `api/meetings`, `events/meetings.*.ts`. The audio itself is carried by a `provider.media` plugin ([media-livekit.md](./media-livekit.md)); decision record:
[docs/spikes/voice.md](../spikes/voice.md). `dependsOn` channels, files and bots (rooms hang off channels; the transcript file and the note-taker bot are later tasks).

## What a person gets

- **Start** in a channel (`POST /api/channels/:channelId/meetings`): whoever may post there. One live room per channel: starting while one is live returns that room (`created: false`) and joins the person to it.
  The title defaults to "Voice room · 14:02" (UTC). A **call thread** is created at the same time, a message in the channel the room points at (`threadRootId`); people in the call reply there with the
  channel's own messages, files and @mentions. If the message cannot be written the room still opens. A call in a direct message is a room in the DM's channel (`teamId` is null; only that conversation sees it).
- **Join** (`POST /api/meetings/:id/join`): a person who can read the channel. The answer holds the media address and a token that lives at most 10 minutes. A room takes 50 people.
- **Renew the token** (`POST /api/meetings/:id/token`): only while the person is in the room and can still read its channel.
- **Leave** (`POST /api/meetings/:id/leave`), **heartbeat** every 30 seconds while in the room (`POST /api/meetings/:id/heartbeat`, optionally `{ speaking }`).
- **End** (`POST /api/meetings/:id/end`): the starter, a lead of the room's team, or a workspace admin. Everyone in the room is dropped. An admin who cannot read a private channel cannot end its room
  (the database function checks that the caller could read it); a call in a DM can be ended only by the person who started it (a DM has no team lead).
- **Look**: `GET /api/meetings/:id`, `GET /api/teams/:slug/meetings?state=live|ended` (a team's live rooms), `GET /api/meetings/live` (the live rooms the caller can see), `GET /api/meetings/media-status`
  (`{ configured, provider, reason }`).
- **Not set up**: with no media server configured, start, join and token answer **409** with "Voice rooms are not set up" and a plain reason, and write nothing. Everything that only reads still works.

A bot cannot start, join, leave or end a room (403); no session is 401. A bot never gets a media token.

## Tables (migration `0001_meetings.sql`, namespace `meetings`)

All forced row-level security with a `rls:` comment; the system role has `FOR ALL` on each.

- `meetings`: team (nullable for a DM call), channel (cascade), title (one line, at most 120), `state` `live`/`ended`, `started_by`, `organizer_id`, `note_taker_bot_id`, `started_at`, `ended_at`, `ended_by`,
  `end_reason` `person`/`empty`, `transcription` `off`/`on_device`/`server`, `recording`, `empty_since`, `thread_root_id`, transcript location. A partial unique index allows one `live` room per channel.
  Read: whoever reads the channel. Insert: a person who may post in the channel, as themself; the trigger fixes state, settings and times. A direct `UPDATE` of state is refused by the guard trigger:
  a room ends only through `app.meetings_end(meeting, reason)`.
- `meeting_participants` (PK meeting + actor): who is or was in the room, their name copied at join, `first_joined_at`, `joined_at`, `left_at`, consent to transcribe and to record (`yes`/`no`/`unasked`, the
  person's own answer). Insert: the person themself, people only (a bot is refused by the trigger), into a live room they can read. Update: their own row (leave, come back, consent).
  A trigger keeps `meetings.empty_since`: set when the last person leaves, cleared when anyone is in.
- `meeting_segments`: transcript lines (meeting, speaker, `start_ms`, `end_ms`, text, `source` `device`/`server`). Insert by the speaker themself, source `device`, while present. Never updated.
- `meeting_presence` (**UNLOGGED**): the heartbeat, `seen_at` and `speaking`. A person writes and reads only their own row. It may be lost in a crash; the sweep then waits for the next heartbeat.

## Jobs

- `meetings.autoend`: queued two minutes after the last person left; ends the room if it is still empty (database clock).
- `meetings.sweep` (every minute, detached): drops people silent for 3 minutes, drops people who can no longer read the channel (`kicked`), ends any room empty for 2 minutes (the net under a lost autoend job).

## Access loss

`channel.member.removed` and `team.member.removed` are consumed: the person is dropped from every live room they can no longer read (checked with `app.channel_audience`), the media server is told to
remove them, and the next token or join answers 404. Target: within 5 seconds (tested with the fake provider). A webhook saying a person joined who is not in the room kicks them again.

## Events

`meetings.meeting.started`, `meetings.meeting.ended`, `meetings.participant.joined`, `meetings.participant.left` are emitted here. `meetings.consent.changed`, `meetings.transcript.written` and
`meetings.notes.written` are registered for the tasks that write them (P15-05, P15-09, P15-10). Payloads hold ids and times, never a title or any text. The plugin consumes `channel.member.removed` and `team.member.removed`.

## Limits

Per person a minute: starting a room 10, joining 60, token renewals 60 (`docs/deploy/rate-limits.md`); heartbeat 20; end 30. The media server's webhook: 120 a minute per address.

## Settings

| Variable | Meaning |
|---|---|
| `MANYTHREADS_MEDIA_PROVIDER` | which `provider.media` plugin to use; default `livekit` |
| `MANYTHREADS_LIVEKIT_URL`, `_API_KEY`, `_API_SECRET`, `_API_URL` | see [media-livekit.md](./media-livekit.md) |

## Tests

`packages/plugins/meetings/test/meetings-api.test.ts` (routes, authorisation, rate limit, auto-end, kick, webhook), `not-configured.test.ts`, `rls/meetings-rls.test.ts` (`pnpm test:rls`); the events:
`packages/shared/test/events/phase15-meetings-contracts.test.ts`. The tests use the `media-fake` test-only plugin (a deterministic provider that records every room, token and kick).
