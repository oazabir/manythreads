# meetings

Voice rooms, their transcripts, notes and note-taker (PLAN P15-01 to P15-24): a person starts a voice room in a channel, others join, and the room ends when someone ends it or two minutes after the last person left.
This page is the backend (rooms, who is in them, the routes, the jobs, the events), how words get into a transcript, where the transcript and the notes live, the note-taker and sharing. Code:
`packages/plugins/meetings`. Schemas: `packages/shared/src/entities/meeting.ts`, `api/meetings`, `events/meetings.*.ts`. The audio itself is carried by a `provider.media` plugin
([media-livekit.md](./media-livekit.md)); words from audio on the server come from [asr.md](./asr.md); decision record: [docs/spikes/voice.md](../spikes/voice.md). `dependsOn` channels, files and bots.
The web part is in `clients/web/src/meetings` (the call bar) and `clients/web/src/screens/meetings` (the meeting page).

## What a person gets

- **Start** in a channel (`POST /api/channels/:channelId/meetings`): whoever may post there. One live room per channel: starting while one is live returns that room (`created: false`) and joins the person to it.
  The title defaults to "Voice room · 14:02" (UTC). A **call thread** is created at the same time, a message in the channel the room points at (`threadRootId`); people in the call reply there with the
  channel's own messages, files and @mentions. If the message cannot be written the room still opens. A call in a direct message is a room in the DM's channel (`teamId` is null; only that conversation sees it).
- **Join** (`POST /api/meetings/:id/join`): a person who can read the channel. The answer holds the media address and a token that lives at most 10 minutes. A room takes 25 people unless an admin changes `room_cap` (2 to 100); the 26th person gets 409 "This voice room is full (25 people)".
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

- `meetings`: team (nullable for a DM call), channel (cascade), title (one line, at most 200), `state` `live`/`ended`, `started_by`, `organizer_id`, `notetaker_bot_id`, `started_at`, `ended_at`, `ended_by`,
  `end_reason` `person`/`empty`, `transcription` `off`/`on_device`/`server`, `recording`, `empty_since`, `thread_root_id`. Migration 0003 adds `notetaker_by` and `recording_by`. A partial unique index allows one `live` room per channel.
  Read: whoever reads the channel. Insert: a person who may post in the channel, as themself; the trigger fixes state, settings and times. A direct `UPDATE` of state is refused by the guard trigger:
  a room ends only through `app.meetings_end(meeting, reason)`.
- `meeting_participants` (PK meeting + actor): who is or was in the room, their name copied at join, `first_joined_at`, `joined_at`, `left_at`, consent to transcribe and to record (`yes`/`no`/`unasked`, the
  person's own answer). Insert: the person themself, people only (a bot is refused by the trigger), into a live room they can read. Update: their own row (leave, come back, consent).
  A trigger keeps `meetings.empty_since`: set when the last person leaves, cleared when anyone is in.
- `meeting_segments`: transcript lines (meeting, speaker, `start_ms`, `end_ms`, text, `final`, `lang`, `source` `device`/`server`, `client_seg_id`, `edited_at`). A person inserts their own `device` lines while present; the server inserts `server` lines (the fallback upload, the note-taker, a voice message in the call thread) as the system. A line is accepted until two minutes after the room ended (`MEETING_LATE_LINE_SECONDS` 120). A line is changed only by its speaker through `app.meetings_correct_segment` (24 hours). One line per `(meeting, speaker, client_seg_id)`. Trigram index on the text, BRIN on `created_at`.
- `meeting_presence` (**UNLOGGED**): the heartbeat, `seen_at` and `speaking`. A person writes and reads only their own row. It may be lost in a crash; the sweep then waits for the next heartbeat.

## Jobs

Queues the plugin registers (all run on the server; the ones marked "detached" do not hold the request that queued them):

| Queue | What it does |
|---|---|
| `meetings.autoend` | two minutes after the last person left: ends the room if it is still empty (database clock) |
| `meetings.sweep` (every minute, detached) | drops people silent for 3 minutes, drops people who can no longer read the channel (`kicked`), ends any room empty for 2 minutes (the net under a lost autoend job) |
| `meetings.ringend` | 30 seconds after a direct-message call started with nobody else in it: a "Missed call" message |
| `meetings.transcript` | 2 min 10 s after the end (and again, debounced 30 s, after a correction): writes `transcript.md` |
| `meetings.notes` | the Scribe's notes for a room without a note-taker, then the memory filing |
| `meetings.notetaker.announce` | the line in the call thread when a note-taker is added or removed |
| `meetings.listener.start`, `meetings.listener.sweep` | start the note-taker's listener after the change is committed; the sweep starts one for a room that has a note-taker and no listener in this process (after a restart) |
| `meetings.notetaker.notes` | notes of a room that had a note-taker (written into the organizer's Personal folder) |
| `meetings.question` | a question put to the note-taker: the check, then the answer |
| `meetings.recorder.start`, `meetings.recorder.sweep` | recording (see "Recording") |

## Access loss

`channel.member.removed` and `team.member.removed` are consumed: the person is dropped from every live room they can no longer read (checked with `app.channel_audience`), the media server is told to
remove them, and the next token or join answers 404. Target: within 5 seconds (tested with the fake provider). A webhook saying a person joined who is not in the room kicks them again. The listener
hears a person only while they are present with consent yes, so a removed person's audio stops within the listener's two-second check.

## Events

Emitted here: `meetings.meeting.started`, `meetings.meeting.ended`, `meetings.participant.joined`, `meetings.participant.left`, `meetings.consent.changed`, `meetings.transcript.written`, `meetings.notes.written` (with
`actionOwnerIds`), `meetings.notes.shared`, `meetings.notes.saved`, `meetings.notetaker.added`, `meetings.notetaker.removed`, `meetings.recording.started`, `meetings.recording.stopped`; also `channel.channel.created`
(the note-taker's first conversation with the organizer). Payloads hold ids and times, never a title or any text. Consumed: `channel.member.removed`, `team.member.removed`, `channel.message.posted` (a voice message in a
call thread becomes a line; a mention of the note-taker in the thread is a question), `meetings.meeting.ended` (the transcript job) and `meetings.transcript.written` (the notes job). The audit plugin records
started, ended, consent changed, note-taker added and removed, recording started and stopped, notes shared and saved (ids only).

## Limits

Per person a minute: starting a room 10, joining 60, token renewals 60 (`docs/deploy/rate-limits.md`); heartbeat 20; end 30; lines posted 240 (a batch holds at most 20); corrections 60; audio chunks 120. Per room a
minute: 1000 lines (429 after), 6 questions to the note-taker answered a minute and 20 model checks ("is this a question for it?") a minute per room, past which a line that names the note-taker is dropped. The media server's webhook: 120 a minute per address. A line is at most 4000 characters (a longer one is refused with 413); the server strips control
and bidirectional characters before storing it; a transcript file is at most 2 MB and then says "transcript truncated". People in a room: `meeting_settings.room_cap` (25). Note-taker rooms in one server process:
`MANYTHREADS_NOTETAKER_MAX_ROOMS` (10).

## Settings

| Variable | Meaning |
|---|---|
| `MANYTHREADS_MEDIA_PROVIDER` | which `provider.media` plugin to use; default `livekit` |
| `MANYTHREADS_LIVEKIT_URL`, `_API_KEY`, `_API_SECRET`, `_API_URL` | see [media-livekit.md](./media-livekit.md) |
| `MANYTHREADS_NOTETAKER_MAX_ROOMS` | rooms with a note-taker one server process listens to at once, default 10, at most 100 (the chart value is `media.noteTakerMaxRooms`) |
| `MANYTHREADS_RECORDING_MAX_ROOMS` | rooms recorded at once in one server process, default 10 |
| `MANYTHREADS_FAKE_ASR` | `1` is a test stand-in for the speech-to-text server; the server refuses to start with it when `NODE_ENV=production` ([asr.md](./asr.md)) |

Workspace switches (`GET/PUT /api/workspace/meetings-settings`, admin): `transcribeCap` (`off`, `on_device`, `server`; default `on_device`), `roomCap` (default 25), `recordingCap` (`off` by default) and `notetakerAllowed` (default on).
Team switches, in the front matter of the team's `TEAM.md` under `meetings:`: `transcribe` (`off`, `on_device`, `server`), `noteTaker` (`on`, `off`), `autoMemory` (default `true`) and `keepAudioDays` (default 30). A key that is
left out takes its default; a key that is present but not valid takes the closed choice (`off`, `false`), so a typo never opens what a team meant to keep closed.

## Tests

Server, `packages/plugins/meetings/test`: `meetings-api.test.ts` (routes, authorisation, rate limit, auto-end, kick, webhook), `not-configured.test.ts`, `consent.test.ts`, `segments.test.ts`, `captions.test.ts`,
`limits.test.ts`, `hostile-text.test.ts`, `writer.test.ts`, `audio-chunks.test.ts`, `notes.test.ts`, `notes-unit.test.ts`, `notetaker.test.ts`, `listener.test.ts`, `questions.test.ts`, `shares.test.ts`, `save.test.ts`,
`recording.test.ts`, and under `rls/`: `meetings-rls.test.ts`, `meetings-bundle-c-rls.test.ts`, `meetings-search-rls.test.ts` (`pnpm test:rls`). The events: `packages/shared/test/events/phase15-meetings-contracts.test.ts`.
The tests use the `media-fake` test-only plugin (a deterministic provider that records every room, token, kick and listener). The end-to-end specs are `e2e/meetings`, `e2e/api/meetings` and `e2e/visual/meetings`; the
live check is `e2e/screens/task.verify-bundle-c.shots.ts`.

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
nothing else happens. Words come from `engine.ts` (see "How words get into a transcript"); captions, the note-taker picker and the recording toggle are `Captions.tsx`, `NotetakerPicker.tsx` and `RecordingToggle.tsx` in the same folder. The meeting page is `screens/meetings` (route `/meetings/:meetingId`, `?t=<ms>` jumps to a line).

Tests: `clients/web/test/meetings-model.test.ts`, `meetings-call.test.ts` (the controller against the in-memory media layer), `meetings-live.test.ts`, `meetings-engine.test.ts`, `speech-stream.test.ts`, `meetings-view.test.ts`, `meetings-view-words.test.ts`; server: `test/consent.test.ts`.

### Only a live server shows

Real microphone capture, echo cancellation and noise suppression quality; the device picker with real devices; speaking detection from the media server; the reconnect after a real network drop; the join /
leave / ring sounds on a real speaker; the browser's autoplay rule for remote audio; the bottom sheet on a real phone; the page's content security policy letting the page reach the media server's address
(`connect-src`, see the deploy notes); the ring push on a phone.

## How words get into a transcript

Every line ends in one function, `takeSegments` (`segments.ts`), whatever its source, so the same rules apply to each:

- **From a device** (`POST /api/meetings/:meetingId/segments`, up to 20 lines): the person's own browser writes out their own microphone with the on-device Whisper model of P14-16 (`clients/web/src/speech/stream.ts`, driven by
  `meetings/engine.ts`) and sends the words, not the audio. A partial line (the engine may still change it) is only ever a caption; a final line is stored. The browser measures how far its clock is from the server's through the
  heartbeat answer (`serverNow`) so a line lands at the right time in the meeting (`startMs` is milliseconds since the room started). A test build (`VITE_MANYTHREADS_FAKE_ASR=1`) has no engine; a spec calls
  `window.__manythreadsSay(text)` to say something.
- **From the server's speech-to-text** for a person who chose `server` and whose room and caps allow it (`POST /api/meetings/:meetingId/audio-chunks`, a 16 kHz mono WAV of at most 30 s and 2 MB; `routes-audio.ts`). The bytes
  go to the `transcribe` door of the LLM gateway ([asr.md](./asr.md)) and are dropped; nothing is written to disk or storage. Refused (403) unless the sender is present, said yes, and the room's mode is `server`.
- **From the note-taker's listener** (see "The note-taker").
- **From a voice message** posted in the call's thread while the room is live (or in the late window), with its transcript: a `device` line for its author, if they said yes.

The rules: control and bidirectional characters are stripped; a speaker who has not said yes leaves only the times of their speaking (the database trigger blanks the words); a final line that repeats what another device of the
same speaker already sent (same words, the times overlapping by half or more of the shorter) is dropped; the same `clientSegId` twice is stored once; the speaker may correct their own line for 24 hours
(`PATCH /api/meetings/:meetingId/segments/:segId`), which writes the transcript file again 30 seconds later.

**Captions.** The server pushes `meeting.caption` to the people present, collected per room into one push at most every 250 ms (four a second however many people speak). The collecting is in the memory of one server process;
with two replicas each collects for itself, which is acceptable because the live site runs one. A backlog of more than 60 seconds of audio shows "catching up".

**Late lines and the clock.** A line is accepted until two minutes after the room ended. The transcript job runs at two minutes ten seconds.

## Where a transcript and its notes live

| Kind of meeting | Transcript and notes |
|---|---|
| A public channel's room | the team repository, `meetings/YYYY/MM/DD-HHMM-slug/{transcript,notes}.md`, one commit made by the platform, the speakers as `Co-authored-by` |
| A private channel's or a direct message's room | the channel's Files folder, `channels/<name>/meetings/<same>/` (`dms/<id>/…` for a direct message), readable by exactly the people who can read the room |
| A room with a note-taker | the **organizer's Personal files**, `Meetings/YYYY-MM-DD-HHMM-slug/{transcript,notes}.md`; the room's own transcript job does not write a second copy |

`meetings/` in a team repository is guarded: only the platform writes there. Nobody can commit it directly, no proposal can change it, and the Files tree shows it read-only. The transcript starts with a small front matter
(`type: Meeting Transcript`, title, date, start, duration, channel, participants, language, `source`) and has one line per stretch of speech, `[00:12:04] **Nadia:** words`. What was said is escaped, so it cannot become a
heading, link or tag. A person who did not say yes shows as "<name> spoke (not transcribed)" with the time. `meeting_notes.transcript_path` holds the path of the transcript for **every** kind of meeting (for a
note-taker meeting it is the Personal path, which only the organizer can open directly; others read it through the meetings routes after a share, below).

## The Scribe and the notes (P15-10 to P15-12)

After a room's transcript is written (no note-taker in it), the `meetings.notes` job asks the team's Scribe for the notes. The Scribe is an ordinary team bot (`templates/*/bots/scribe`, trigger `meeting_ended`,
holds `meetings.read`, `memory.recall` and `meetings.write_notes`, hidden from the mention picker because nobody can address it; `meetings.read` opens only a room of the run's team without a note-taker whose notes are still pending, never a Personal transcript). `runtime-hermes` registers the `meeting.runs` provider; its `notes` method runs the
Scribe synchronously with the transcript in the prompt (`@<ms> | <clock> | <speaker>: <words>`, between markers, as data) and reads one JSON object back. An answer that is not an object is asked for once more.

* The platform checks the answer: an item whose time is not inside a transcribed line is dropped; an owner is a team member by exact display name, else only the name is kept; an owner who did not say yes to being
  transcribed becomes "no owner". The model never writes a file: the platform renders `notes.md` beside the transcript.
* `meetings.notes.written` carries ids only, including `actionOwnerIds`. The notifications plugin turns it into one `meeting_actions` notification for each owner ("2 action items from Sprint review"), which opens `/meetings/<id>`.
  On the meeting page each action item has "Add to board": the web calls the existing task-card route as the person.
* A public channel's meeting is filed into the team's memory inbox by itself (origin `meeting`, the consenting speakers as droppers; a room with somebody outside the team is held for a lead; `autoMemory: false` turns it
  off). A private channel, a direct message, or a team without the switch is filed only by `POST /api/meetings/:meetingId/send-to-memory` after the person sees the warning and confirms. The concept's `sources` point at the
  inbox original; the transcript path and the `[hh:mm:ss]` line times are inside that text.
* A run that fails (or answers twice without an object) sets `meeting_notes.status = 'failed'` and the thread says "The notes could not be written", with the transcript path and a link to the meeting. A budget that
  says "later" is tried again after 15 minutes, up to six times.
* The thread line is written by the Scribe's own actor in a transaction of its own after the notes are saved.
* People edit the notes through `PUT /api/meetings/:meetingId/notes` (the plugin writes the file, the person is the author).

## The note-taker (P15-18 to P15-24)

A note-taker is a team bot whose `BOT.md` has the trigger `{ type: meeting }`; the Engineering, Customer support, Product design, Research and Marketing templates ship one (`templates/*/bots/note-taker`, capabilities
`meetings.read`, `meetings.search`, `messages.search`, `memory.recall`, `meetings.write_notes`; its runs are started by the platform on `meeting_ended` and `meeting_question`). A team that already exists does not get a template
change by itself: add `bots/note-taker/BOT.md` through the repository.

**Adding it** (`PUT /api/meetings/:meetingId/notetaker`, anyone in the room; removing it, `DELETE`, the organizer, the person who added it or a team lead; `GET …/notetakers` lists who can be added and says why "Add note-taker"
is disabled). It is refused, with a plain reason, when the media server cannot host a listener, the workspace has `notetakerAllowed` off or the team has `meetings.noteTaker: off`, transcription is off by a cap, the
`transcribe` alias is not bound, the room already has one, or this server process already listens to `MANYTHREADS_NOTETAKER_MAX_ROOMS` rooms (409 "The note-taker is busy, try again in a minute."). Adding it moves the
room to server transcription, sets everyone's answer back to "not asked" and posts a line in the call thread ("<name> added Note-taker. It listens on the server and writes notes for <name>.").

**The listener** (`listener.ts`, and `media-livekit/src/listener*.ts`, see [media-livekit.md](./media-livekit.md)). It joins the room as a hidden, subscribe-only participant `notetaker:<meetingId>` (never an actor id, because the
media webhook would drop an unknown actor id from the room). The list of people it hears is the people present with consent yes; it is checked against the database every two seconds, so a withdrawn yes, a leave or a kick
stops that person's audio well inside five seconds, and what was buffered for them is thrown away. The audio is cut at pauses (600 ms of silence, at most 30 s per chunk, `sdk/src/audio/vad.ts`), each chunk checked once more,
sent to `transcribe` and stored as a `server` line by `takeSegments`; captions are pushed. Every 30 seconds the new lines are appended to the organizer's Personal transcript (`personal.files` as the system, the bot as author).
The bot never publishes audio, and a bot never receives a media token: only the plugin mints the listener's token. Over `MANYTHREADS_NOTETAKER_MAX_ROOMS` it answers 409. One server process is assumed: with two, both would join.

**After the call** the `meetings.notetaker.notes` job asks the note-taker's run for the notes (the same JSON and checks as the Scribe), writes `notes.md` beside the Personal transcript and posts, through the
`meeting.runs.say` provider method (a bot may post only inside a run opened for that channel, so `say` opens one), a message from the note-taker to the organizer in their conversation with it: title, that the notes are in
their Personal files, and `meta.meetingNotes { meetingId }` so the page draws Share and Save-to-team buttons. The call thread gets "Notes are with <organizer>." If the run fails, `meeting_notes.status = 'failed'` and the
same message says the transcript is there.

**A removed note-taker.** If the note-taker is removed before the room ends, its listener leaves at once and stops hearing anyone; lines already written stay in the database and in the organizer's Personal
`transcript.md` (the listener appends every 30 seconds and once more when it closes). When the room then ends, the room's own transcript job (`writer.ts`, `writeTranscript`) decides by the file that exists:
if the note-taker already created the Personal transcript (`meeting_notes.location = 'personal'`), the job writes nothing and the Personal copy stays the only copy, because the people in the call were told
a private note-taker was listening and the organizer has not chosen to publish it (they can use Save to team); lines spoken after the removal (from devices or the server fallback) are in the database and the
meeting page but not in that file. If the note-taker was removed before it wrote anything (no Personal file yet), the job writes the normal repository or channel Files copy and the Scribe makes the notes.

**Questions in the call** (P15-22, `questions.ts`). Final lines of people who said yes are scanned (NFKC and lower case, one linear pass, whole words only) for the bot's name, its slug or "note-taker"; a hit queues
`meetings.question`. One `fast` model call over the last 60 seconds decides whether the newest line is a question for the note-taker. A message in the call thread that **@mentions** the note-taker (the text `@note-taker`
or the real mention) skips that check. Then the note-taker's `answer` run may read only the channels **every person in the call** may read (each person's own visible set, taken as that person), no Personal files; an answer
that used anything else is thrown away. The answer is posted in the thread and shown as a caption that names the asker. One question at a time, six a minute per room, a question older than two minutes is dropped, and a
line of someone who did not say yes is never taken as a question.

**Share and save** (P15-23). The organizer shares the notes with a person or a channel (`GET/POST …/shares`, `DELETE …/shares/:shareId`, audit rows); a reader then gets the notes through `GET …/notes` and the transcript through
`GET …/transcript?copy=organizer`. The meetings plugin serves them from the Personal file after `app.meetings_can_read_notes` says yes (the organizer, a person with an unrevoked share who is still in the team, or a member
of a shared channel); Files rules are not changed, so the Personal folder stays closed to everyone else. A shared reader who has left the team gets 404. The room's own `GET …/transcript` follows the same rule once a note-taker room has ended and until the notes are saved to the team: only the organizer, a share or the team's copy opens it (404 for anyone else, including people who were in the call); while the room is live everyone in it reads as before. The organizer reaches the notes written for the team only while they can still read the place of the call (migration 0004); their own Personal copy stays theirs. **Save to team**
(`POST /api/meetings/:meetingId/save-to-team`, the organizer, once: 409 after) copies both files into the team repository's `meetings/` folder with the organizer as author and, with the box ticked, files the notes into
team memory as above. The meeting page (`GET …/summary`, `GET /api/meetings/by-path` from a file in the Files tree) shows people, length, links, decisions, action items and whether it is filed to memory.

## Search and Brain

`meeting_segments.text` and `meeting_notes.notes_md` have trigram indexes; the search plugin's function `app.search_meetings` reads them through the normal policies, keeps only the words of a speaker whose answer is yes and leaves out a
note-taker's transcript while it is still the organizer's own. Search scope `meetings`; the capability `meetings.search` gives a bot the same answer the person would get. An answer citation of kind `meeting` opens
`/meetings/<id>?t=<ms>` at the line.

## Live checks

`e2e/screens/task.verify-bundle-c.shots.ts` runs against the live site from the devbox with two real Chromium contexts and two real read-aloud clips (`e2e/fixtures/speech/nadia.wav` and `rafi.wav`, LibriSpeech, CC BY 4.0).
A line is judged by "contains one of the reference words" (`references.json`), never by an exact text. A step whose prerequisite is missing (no media server, no `transcribe` binding, no Hermes pod) records
"SKIPPED: reason".

## Bundle C contracts (the routes and where they live)

"Provider" here means a service one plugin registers and another reads through the SDK (`ctx.providers`); "capability" means a named action the bot broker checks before a bot may do it. Zod shapes are in
`packages/shared/src/api/meetings/`, handlers in `packages/plugins/meetings/src/`.

### Routes

| Route | Shared constant | Handler file |
|---|---|---|
| `POST /api/meetings/:meetingId/segments` (up to 20 final lines; partial lines become captions only) | `postMeetingSegmentsRoute` | `routes-transcript.ts` |
| `PATCH /api/meetings/:meetingId/segments/:segId` (correct your own line for 24 hours) | `patchMeetingSegmentRoute` | `routes-transcript.ts` |
| `POST /api/meetings/:meetingId/audio-chunks` (WAV body, server fallback) | `postMeetingAudioChunkRoute` | `routes-audio.ts` |
| `GET /api/meetings/:meetingId/summary` | `getMeetingOverviewRoute` | `routes-notes.ts` |
| `GET /api/meetings/by-path` | `getMeetingByPathRoute` | `routes-notes.ts` |
| `GET` / `PUT /api/meetings/:meetingId/notes` | `getMeetingNotesRoute`, `putMeetingNotesRoute` | `routes-notes.ts` |
| `GET /api/meetings/:meetingId/transcript` (`?copy=organizer` for a shared reader) | `getMeetingTranscriptRoute` | `routes-consent.ts` |
| `POST /api/meetings/:meetingId/save-to-team` | `saveMeetingToTeamRoute` | `routes-notes.ts` |
| `POST /api/meetings/:meetingId/send-to-memory` | `sendMeetingToMemoryRoute` | `memory.ts` |
| `GET` / `POST /api/meetings/:meetingId/shares`, `DELETE …/shares/:shareId` | `listMeetingSharesRoute`, `createMeetingShareRoute`, `deleteMeetingShareRoute` | `shares.ts` |
| `GET …/notetakers`, `PUT` / `DELETE …/notetaker` | `listMeetingNotetakersRoute`, `setMeetingNotetakerRoute`, `removeMeetingNotetakerRoute` | `notetaker.ts` |
| `GET` / `PUT …/recording`, `POST …/record-consent` | `getMeetingRecordingRoute`, `setMeetingRecordingRoute`, `meetingRecordConsentRoute` | `recording.ts` |
| `POST /api/test/media/speak` (test servers only; says a line as a person the listener hears) | `fakeMediaSpeakRoute` | `media-fake` plugin |

The heartbeat answer is `{ ok: true, serverNow }`. `MeetingTranscriptLine` carries `segmentId` and `editable`.

### Events

New in this bundle: `meetings.notetaker.added`, `meetings.notetaker.removed`, `meetings.recording.started`, `meetings.recording.stopped`, `meetings.notes.shared`, `meetings.notes.saved`; `meetings.notes.written` gains
`actionOwnerIds`. Bot run triggers gain `meeting_ended` and `meeting_question`; BOT.md triggers gain `{ type: meeting }` and `{ type: meeting_ended }`. Notification kind `meeting_actions`; inbox origin `meeting`; answer citation
kind `meeting`.

### Capabilities, providers, extension points

Capabilities declared by the manifest: `meetings.read`, `meetings.write_notes`, `meetings.search` (none destructive). (A capability name has one dot: `namespace.verb`.)
Providers: `meeting.runs` (registered by `runtime-hermes`; methods `notes`, `answer` and `say`) and `inbox.dropper` (registered by `memory-inbox`; files a meeting into a team's inbox), with extension points
`provider.meeting.runs` and `provider.inbox.dropper`. `MediaProvider.listen?` is optional so a provider without a listener still works; the LiveKit adapter and the fake provider both implement it. The SDK holds
`LlmTranscriber` (the `transcribe` door of gateway-llm), the WAV helpers (`audio/wav.ts`) and the voice-activity segmenter (`audio/vad.ts`).

### Migrations

`meetings/0003_transcripts_notes.sql` (late-line window, `client_seg_id`, `edited_at`, BRIN and trigram indexes, `app.meetings_correct_segment`, the tables `meeting_notes`, `meeting_shares`, `meeting_recordings`,
`app.meetings_set_notetaker`, `app.meetings_set_recording`, `app.meetings_can_read_notes`, settings columns `room_cap`, `recording_cap`, `notetaker_allowed`) · `meetings/0004_organizer_leaves.sql` (the organizer's right to the team's copy ends with their right to the place) · `bots/0030_meeting_triggers.sql` · `memory-inbox/0005_meeting_origin.sql` ·
`notifications/0006_meeting_actions.sql` · `search/0007_meetings.sql` · `answer/0009_meeting_citations.sql` · `retention/0002_meeting_audio.sql`.

## Recording (`recording.ts`, P15-15)

Off until an admin sets the workspace switch `recordingCap` to `on`. A person in the room turns recording on for that room (`PUT …/recording`); that sets everyone present back to "not asked" and every person
answers for themselves (`POST …/record-consent`). A hidden listen-only participant, `recorder:<meetingId>`, joins the room; it publishes nothing. It hears a person only while **everyone present** has said yes, so
one "no", or a newcomer who has not answered, stops every file at once (within about two seconds, and half a second at the chunk level) and the call thread gets one plain line. A yes counts only if it was given after
the person last joined the room: a yes left over from before leaving and coming back is taken back to "not asked". Each consenting person gets one 16 kHz mono WAV, stored as the system actor in the channel's Files
at `channels/<name>/meetings/<dd>-<hhmm>-<slug>/audio/<person>.wav` (`dms/<id>/…` for a direct message), with the recorded person as uploader. Audio never goes to git. Stop reasons: `turned_off`, `left`, `ended`,
`consent_withdrawn`, `joined_without_yes`, `failed`. Events carry ids only. Limits: three hours per person per file, `MANYTHREADS_RECORDING_MAX_ROOMS` rooms at once (default 10), one server process. Files expire per
[retention](./retention.md) (default 30 days, `meetings.keepAudioDays` in `TEAM.md`). Exports for other packages: `audioFolder()`, `audioSlug()`, `isRecording()`, `recordingNow()`, `RECORDER_START_QUEUE`.

## Bundle D contracts (P16-05, planned rooms)

A plan is not a room. `app.scheduled_meetings` and `app.scheduled_meeting_attendees` (`meetings/0005_scheduled.sql`) hold a voice room planned ahead in a channel; the room itself is made when someone presses
Start at the time, or opens the join link `/join/<id>`, and that room remembers its plan (`meetings.scheduled_meeting_id`, set by the trigger `meetings_mark_scheduled_started`). The organizer's own calendar
(Google or Microsoft, through the `connections` calendar provider) carries the event; outside guests are only a count, their addresses are never kept. Enums: `ScheduledMeetingStatus` (`scheduled`, `cancelled`,
`started`), `ScheduledMeetingProvider` (`google`, `microsoft`).

Routes (shared `api/meetings/scheduled.ts`): `POST|GET /api/channels/:channelId/scheduled-meetings`, `GET|PATCH|DELETE /api/scheduled-meetings/:scheduledMeetingId` (the GET answers with a `gate`, the state of
the plan that someone who may not read the channel is told, and the plan itself only for a reader), `POST /api/scheduled-meetings/:scheduledMeetingId/join`. Limits: 100 waiting plans per channel, 50 invited,
120-character title, 8000-character agenda, at most 366 days ahead and 24 hours long. Events (ids and counts only): `meetings.scheduled.created|changed|cancelled|starting_soon`. The reminder is the notification
kind `meeting_soon` (`notifications/0007_meeting_soon.sql`, ref type `scheduled_meeting`), sent five minutes ahead by the queue `meetings.scheduled-reminders`; the queue `meetings.scheduled-sync` reads the
calendar for moved or deleted events. The definer functions `app.meetings_schedule`, `app.meetings_cancel_scheduled` and `app.meetings_scheduled_gate` do the writes and the gate under the caller's rights.
Work package C fills in `scheduled.ts`, `scheduled-jobs.ts` and `routes-scheduled.ts`; every route answers 501 "Not built yet" until then.
