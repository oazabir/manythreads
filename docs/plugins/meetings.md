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

## Consent and transcription (migration `0002_consent.sql`, P15-05)

Transcription is off in a new room. Anyone in the room can turn it on (`PUT /api/meetings/:id/transcription`, mode `on_device` or `server`) when the caps allow it; turning it on resets everyone present to
"not answered" and each person answers yes or no (`POST /api/meetings/:id/consent`). A person who has not said yes is never transcribed: the database trigger blanks the words of any segment whose speaker's
current consent is not yes, so the transcript shows a "spoke (not transcribed)" placeholder with the time and no text, and a later "no" blanks the words already stored. The reader judges by the current answer.
A person joining late is asked before the microphone opens (the web client keeps it closed until the answer is sent).

Caps: the lower of two. The workspace switch (`meeting_settings.transcribe_cap`, default `on_device`, `GET/PUT /api/workspace/meetings-settings`, admin) and the team's `TEAM.md` key `meetings.transcribe`
(`off` | `on_device` | `server`; absent means `on_device`; a value that is present but not valid means `off`). `server` needs both caps to say `server`. A direct message has no team, so only the workspace
switch applies. The web client keeps a personal default ("ask", "yes" or "no") in the browser only.

Pushes to people: `meeting.changed` (a room started, changed or ended; the client asks again) and `meeting.ringing` (a direct-message call, rings 30 seconds). If nobody else joined 30 seconds after a
direct-message call started, `meetings.ringend` writes a "Missed call" message to the conversation.

## The web client (`clients/web/src/meetings`, P15-04)

`controller.ts` is the whole life of one call (start, connect, heartbeat every 30 s, token renewal 90 s before it ends, roster every 30 s, mute / deafen / push-to-talk, devices, rejoin up to six times
with a growing wait, consent before the microphone); `store.ts` holds the live rooms for the sidebar badges and the calls ringing; `media.ts` loads the adapter for the provider named in the join answer:
`livekitAdapter.ts` (the `livekit-client` library, loaded only when a call starts, so the main bundle does not grow) or `fakeAdapter.ts` (in memory, for tests). Echo cancellation, noise suppression and
auto gain are on. Ctrl/Cmd+Shift+Space mutes. At 760px and narrower the bar is a bottom sheet. When the server answers 409 "not set up", the bar shows "Voice rooms are not set up on this server" and
nothing else happens. Captions and the transcription engine are not here yet (P15-06, P15-08): the transcription controls stay hidden until an engine exists.

Tests: `clients/web/test/meetings-model.test.ts`, `meetings-call.test.ts` (the controller against the in-memory media layer), `meetings-live.test.ts`; server: `test/consent.test.ts`.

### Only a live server shows

Real microphone capture, echo cancellation and noise suppression quality; the device picker with real devices; speaking detection from the media server; the reconnect after a real network drop; the join /
leave / ring sounds on a real speaker; the browser's autoplay rule for remote audio; the bottom sheet on a real phone; the page's content security policy letting the page reach the media server's address
(`connect-src`, see the deploy notes); the ring push on a phone.

## Bundle C contracts (P15-08: lines, notes, note-taker, sharing, recording)

This section is the contract the later work packages build against. Everything below exists as types, tables and stubs; the stubs answer `501 "Not built yet"` until their package fills them.
"Provider" here means a service one plugin registers and another reads through the SDK (`ctx.providers`); "capability" means a named action the bot broker checks before a bot may do it.

### Routes (shared Zod in `packages/shared/src/api/meetings/`, handlers in `packages/plugins/meetings/src/`)

| Route | Shared constant | Handler file | Built by |
|---|---|---|---|
| `POST /api/meetings/:meetingId/segments` (up to 20 final lines; partial lines become captions only) | `postMeetingSegmentsRoute` | `routes-transcript.ts` | S1 |
| `PATCH /api/meetings/:meetingId/segments/:segId` (correct your own line for 24 hours) | `patchMeetingSegmentRoute` | `routes-transcript.ts` | S1 |
| `POST /api/meetings/:meetingId/audio-chunks` (WAV body, server fallback) | `postMeetingAudioChunkRoute` | `routes-audio.ts` | S3 |
| `GET /api/meetings/:meetingId/summary` | `getMeetingOverviewRoute` | `routes-notes.ts` | S5 |
| `GET /api/meetings/by-path` | `getMeetingByPathRoute` | `routes-notes.ts` | S5 |
| `GET` / `PUT /api/meetings/:meetingId/notes` | `getMeetingNotesRoute`, `putMeetingNotesRoute` | `routes-notes.ts` | S5 |
| `POST …/notes/save-to-team` | `saveMeetingToTeamRoute` | `routes-notes.ts` | S5 |
| `POST …/notes/send-to-memory` | `sendMeetingToMemoryRoute` | `memory.ts` | S2 |
| `GET` / `POST` / `DELETE …/shares` | `listMeetingSharesRoute`, `createMeetingShareRoute`, `deleteMeetingShareRoute` | `shares.ts` | S5 |
| `GET …/notetakers`, `PUT` / `DELETE …/notetaker` | `listMeetingNotetakersRoute`, `setMeetingNotetakerRoute`, `removeMeetingNotetakerRoute` | `notetaker.ts` | S4 |
| `GET` / `PUT …/recording`, `POST …/record-consent` | `getMeetingRecordingRoute`, `setMeetingRecordingRoute`, `meetingRecordConsentRoute` | `recording.ts` | S6 |
| `POST /api/test/media/speak` (test servers only) | `fakeMediaSpeakRoute` | `media-fake` plugin | S3 |

The heartbeat answer is now `{ ok: true, serverNow }` so a device can measure how far its clock is from the server's. Workspace settings gain `roomCap`, `recordingCap` and `notetakerAllowed`;
`TeamMeetingsBundleConfig` is the team's `TEAM.md` `meetings:` block (`noteTaker`, `autoMemory`, `keepAudioDays`). `MeetingTranscriptLine` carries `segmentId` and `editable`.

### Stub files in the plugin (each later package fills its own)

`segments.ts`, `writer.ts`, `limits.ts`, `captions.ts` (S1) · `listener.ts`, `notetaker.ts` (S4) · `questions.ts`, `shares.ts`, `routes-notes.ts` (S5) · `notes.ts`, `memory.ts` (S2) ·
`recording.ts` (S6) · `search.ts` (S7) · `routes-audio.ts` (S3). `not-built.ts` holds `notBuilt()`, the one place that throws the 501.

### Events (all carry ids and times only, never text)

New: `meetings.notetaker.added`, `meetings.notetaker.removed`, `meetings.recording.started`, `meetings.recording.stopped`, `meetings.notes.shared`, `meetings.notes.saved`.
Changed: `meetings.notes.written` gains `actionOwnerIds`. Bot run triggers gain `meeting_ended` and `meeting_question`; BOT.md triggers gain `{ type: meeting }` and `{ type: meeting_ended }`.

### Capabilities, providers, extension points

Capabilities declared by the manifest: `meetings.read`, `meetings.write_notes`, `meetings.search` (none destructive). Providers: `meeting.runs` (registered by `runtime-hermes`; writes notes and answers
questions for a meeting) and `inbox.dropper` (registered by `memory-inbox`; files a meeting into a team's inbox). Both have extension points (`provider.meeting.runs`, `provider.inbox.dropper`) and
kernel registries. `MediaProvider.listen?` is optional so the LiveKit adapter is untouched; the fake provider implements it. The SDK also holds `LlmTranscriber` (gateway-llm answers `unavailable` until S3),
the WAV helpers (`audio/wav.ts`, real) and the voice-activity segmenter (`audio/vad.ts`, a stub).

### Migrations

`meetings/0003_transcripts_notes.sql` (late-line window of 120 seconds, `client_seg_id`, `edited_at`, `app.meetings_correct_segment`, the tables `meeting_notes`, `meeting_shares`, `meeting_recordings`,
`app.meetings_set_notetaker`, `app.meetings_set_recording`, `app.meetings_can_read_notes`, settings columns) · `bots/0030_meeting_triggers.sql` · `memory-inbox/0005_meeting_origin.sql`.
The retention, notifications and search changes belong to S6, S2 and S7.

### Recording (`recording.ts`, P15-15)

Off until an admin sets the workspace switch `recordingCap` to `on`. A person in the room turns recording on for that room (`PUT …/recording`); that sets everyone present back to "not asked" and every person
answers for themselves (`POST …/record-consent`). A hidden listen-only participant, `recorder:<meetingId>`, joins the room; it publishes nothing. It hears a person only while **everyone present** has said yes, so
one "no", or a newcomer who has not answered, stops every file at once (within about two seconds, and half a second at the chunk level) and the call thread gets one plain line. A yes counts only if it was given after
the person last joined the room: a yes left over from before leaving and coming back is taken back to "not asked". Each consenting person gets one 16 kHz mono WAV, stored as the system actor in the channel's Files
at `channels/<name>/meetings/<dd>-<hhmm>-<slug>/audio/<person>.wav` (`dms/<id>/…` for a direct message), with the recorded person as uploader. Audio never goes to git. Stop reasons: `turned_off`, `left`, `ended`,
`consent_withdrawn`, `joined_without_yes`, `failed`. Events carry ids only. Limits: three hours per person per file, `MANYTHREADS_RECORDING_MAX_ROOMS` rooms at once (default 10), one server process. Files expire per
[retention](./retention.md) (default 30 days, `meetings.keepAudioDays` in `TEAM.md`). Exports for other packages: `audioFolder()`, `audioSlug()`, `isRecording()`, `recordingNow()`, `RECORDER_START_QUEUE`.

### The `meetings/` path

`meetings/YYYY/MM/DD-HHMM-slug/` in the team repo is a guarded directory: only the platform (the system actor) writes it. Nobody can commit it directly, no proposal can change it, and the Files tree
and screen show it read-only without a "Propose a change" button.

### The Scribe (P15-10 to P15-12)

After a room's transcript is written (no note-taker in it), the `meetings.notes` job asks the team's Scribe for the notes. The Scribe is an ordinary team bot (`templates/*/bots/scribe`, trigger `meeting_ended`,
holds `meetings.read`, `memory.recall` and `meetings.write_notes`, hidden from the mention picker because nobody can address it). `runtime-hermes` registers the `meeting.runs` provider; its `notes` method runs the
Scribe synchronously with the transcript in the prompt (`@<ms> | <clock> | <speaker>: <words>`, between markers, as data) and reads one JSON object back. An answer that is not an object is asked for once more.

* The platform checks the answer: an item whose time is not inside a transcribed line is dropped; an owner is a team member by exact display name, else only the name is kept; an owner who did not say yes to being
  transcribed becomes "no owner". The model never writes a file: the platform renders `notes.md` beside the transcript (repo commit for a public channel, a Files entry for a private one).
* `meetings.notes.written` carries ids only, including `actionOwnerIds`. The notifications plugin turns it into one `meeting_actions` notification for each owner ("2 action items from Sprint review"), which opens `/meetings/<id>`.
* A public channel's meeting is filed into the team's memory inbox by itself (origin `meeting`; a room with somebody outside the team is held for a lead; `TEAM.md` `meetings.autoMemory: false` turns it off). A private
  channel or a team without the switch is filed only by `POST /api/meetings/:meetingId/send-to-memory` after the person sees the warning and confirms. The concept's `sources` point at the inbox original; the
  transcript path and the `[hh:mm:ss]` line times are inside that text.
* A run that fails (or answers twice without an object) sets `meeting_notes.status = 'failed'` and the thread says "The notes could not be written", with the transcript path and a link to the meeting. A budget that
  says "later" is tried again after 15 minutes, up to six times.
* The thread line is written by the Scribe's own actor in a transaction of its own after the notes are saved.

