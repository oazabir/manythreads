# Phase 15 retro (voice rooms, meeting transcripts, notes, note-taker)

Written at the end of Bundle C (P15-06 to P15-24, web client only; the backend rooms of P15-00 to P15-05 were built earlier). Facts only: what shipped, what is a
stand-in, and what nobody has seen on the live site. **Nothing in this page claims a call, a transcript or a screen was seen on https://manythreads.kahf.to.** Live
results go to `STATUS.md` after `e2e/screens/task.verify-bundle-c.shots.ts` has run. Where to read about each part: `docs/plugins/meetings.md`,
`docs/plugins/media-livekit.md`, `docs/plugins/asr.md`, `docs/deploy.md` ("Voice rooms", "Speech to text").

## What shipped, in the order it landed

1. **Contracts (P15-08 first commit, `d30107af`).** Shared Zod shapes and routes, migration `meetings/0003`, `bots/0030`, `memory-inbox/0005`, SDK interfaces (`MediaProvider.listen`, `LlmTranscriber`,
   `MeetingRunsProvider`, the WAV helpers), stubs that answered 501 until a package filled them.
2. **On-device engine and the upload fallback (P15-06, P15-07 client).** The person's own microphone is cut at pauses and written out by the Whisper worker of P14-16; partial line about once a second, final line per
   chunk, batches to `POST …/segments`. A server fallback uploads the person's own chunks when they chose it.
3. **The `transcribe` door, the audio-chunks route and the deploy assets (P15-07).** gateway-llm door, `MANYTHREADS_FAKE_ASR` stand-in, speaches image with the `tiny` model baked in, chart template, dev compose profile,
   `deploy.sh` build, media chart options for a NAT host (node address, ingress prefix, TURN).
4. **Search and Brain citations (P15-13 server).** `app.search_meetings`, scope `meetings`, capability `meetings.search`, citation kind `meeting`.
5. **Call bar (P15-08 client).** Captions strip, edit your own line, the note-taker picker, the recording toggle, consent copy.
6. **Lines, merge, captions, the transcript file (P15-08, P15-09, P15-14, P15-16 server).** Idempotent line intake, repeat drop, control and bidi strip, room cap from settings, rate limits, captions coalesced to four
   pushes a second, `transcript.md` into the repository (public channel) or Files (private channel, direct message), a voice message in the call thread becomes a line, audit entries.
7. **The meeting page (P15-09, P15-12, P15-13 client).** `/meetings/:id` with notes, transcript, share and save dialogs, "Add to board", the notes card in a direct message, the search row, "Open the meeting" in Files.
8. **The note-taker (P15-18 to P15-20).** Adding and removing it, the listener (worker thread with `@livekit/rtc-node`, hidden `notetaker:<meetingId>`), the voice-activity cutter, chunks to `transcribe`, the
   transcript appended to the organizer's Personal `Meetings/…` folder every 30 seconds.
9. **Recording (P15-15).** One WAV per consenting person while everyone present says yes; retention deletes it after `keepAudioDays`.
10. **The Scribe (P15-10 to P15-12 server).** `meeting.runs` provider in runtime-hermes, notes rendered by the platform, memory filing, `meeting_actions` notifications; the Scribe in all five team templates with 10 eval cases.
11. **Questions, share and save (P15-21 to P15-23, P15-24).** Name scan plus one `fast` check, the thread @mention path, answers limited to what every person present may read, shares, save to team, the note-taker in five
    templates with 8 eval cases, the organizer's message via `meeting.runs.say`.

## Stand-ins

| Real thing | What stands in | Where |
|---|---|---|
| LiveKit | `media-fake` (in-memory rooms, tokens, kicks, listeners) and the web `fakeAdapter` | e2e stacks, unit and RLS tests |
| The browser's Whisper | `VITE_MANYTHREADS_FAKE_ASR=1` and `window.__manythreadsSay(text)` | web test build only |
| speaches on the server | `MANYTHREADS_FAKE_ASR=1`: the text after a `FAKEASR:` marker in the WAV; refused when `NODE_ENV=production` | tests |
| People speaking to the listener | `POST /api/test/media/speak` | test servers only |
| The Scribe's and the note-taker's model | the e2e Hermes stand-in and `tools/fake-llm` scenarios `meeting-notes`, `meeting-question` | e2e and unit tests |
| Speech | `e2e/fixtures/speech/nadia.wav`, `rafi.wav` (real read-aloud English, LibriSpeech, CC BY 4.0; one speaker, two sentences) for the live probe; `hello.wav` is synthetic and holds no speech | live probe |

## Not seen on the live site

- No LiveKit server has accepted one of our tokens, API calls or webhook signatures; no call has carried audio. The media workload is not deployed (`media.enabled` is false on the live release until the owner agrees).
- The `@livekit/rtc-node` worker has only run against a fake worker file in tests: whether the native library loads on the `node:22-slim` image, joins a real room with the hidden token and delivers audio frames is unknown.
- The speaches image has not been built or run here; the accuracy and speed of `tiny` on the devbox CPU are unmeasured; the `transcribe` alias is not bound anywhere.
- The Scribe and the note-taker have run only against stand-in models. The 18 eval cases were written but not scored against a real model. Their JSON from a real model may be malformed (one retry, then `failed`).
- Existing live teams do not have `bots/scribe` or `bots/note-taker` (template changes do not reach them); the live Brain does not have `meetings.search`.
- Real microphone capture, echo cancellation, the device picker with real devices, join and leave sounds, autoplay with real audio, a call between two networks, TURN on 443, the ring push on a phone, a real network
  drop and reconnect, and the 60-minute microphone measurement of P15-00(b) have not been tried.
- Bangla and accented speech, and word error rate on real meetings.
- The dark/light and 390 px plates of the call bar, consent, meeting view, notes card and message card are written as specs; baselines are made only after each picture is opened.

## Limits that are by design

- Caption pushes are coalesced in the memory of one server process (two replicas would each coalesce).
- The note-taker and the recorder each assume one server process; the room limits are per process (`MANYTHREADS_NOTETAKER_MAX_ROOMS`, `MANYTHREADS_RECORDING_MAX_ROOMS`, both 10).
- A question to the note-taker is not read aloud (the answer is posted in the thread and shown as a caption naming the asker).
- Native desktop and phone clients are not part of this bundle (P10-15, P11-09).
- The server-side fallback sends audio only for the sender's own speech, only after they said yes, only when both caps say `server`; the workspace default is `on_device`.

## Gaps found while writing the docs

- `meetings/src/index.ts` still says the modules "answer 501 until the package fills them" and `not-built.ts` is no longer used by any route.
- The app creates every LiveKit room with `max_participants` 50, so the workspace `roomCap` can be raised to 100 but never admits more than 50, and the chart's `media.maxParticipants` (25) has no effect on
  rooms the app creates.
- The note-taker room limit counts rooms with a note-taker in the **database** (all live rooms), not the rooms this process listens to; with one process they are the same.
- A note-taker that was removed before the room ended keeps `meeting_notes.location = 'personal'`; the room's own transcript job does not write a repository copy for it.

## Decisions taken without the owner (reversible)

C1 to C22 of the Bundle C plan are listed in `STATUS.md` with the date: lines go over HTTP; captions at four pushes a second; the meeting clock; two minutes for late lines; repository for a public channel, Files for a private
one, Personal for a note-taker; the platform writes the notes; memory filing by default for a public channel only; action items go to a board as the person; search over lines and notes; recording off by default with a
workspace switch; a room takes 25 people; the listener is a worker thread in the server process; speaches `tiny` as the server's speech-to-text; a note-taker is a bot with the trigger `meeting`; the Personal transcript
of a note-taker meeting; shares and save to team; questions limited to what everyone present may read; questions are not read aloud; the meeting page is `/meetings/:id`.
