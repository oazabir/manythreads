# Voice messages: record like a phone app, send at once, transcribed on the server by Parakeet v3 (Phase 32)

Owner request, 2026-11-18. Today a voice message is recorded in a plain bar ("Recording 0:24 / 5:00", a thin progress line, Cancel and a stop square). A preview step then runs Whisper **in the browser** and shows the words to check before sending. The words are often nonsense: mixed scripts, and the wrong language ("Language: Finnish" for English speech). The person also has to wait for the words before the clip can be sent.

The owner wants:

1. A recording bar like a phone messaging app: delete, a red dot and the time, a live waveform, pause and resume, and a round green send button.
2. Sending straight away, with no transcription on the device and no preview. The message appears as a voice message at once.
3. The **server** transcribes the **first 20 seconds** with **NVIDIA Parakeet TDT 0.6B v3**. The message shows that this is under way, then updates in place with a transcript preview.
4. The player as in the owner's picture: play, a waveform with a moving dot, the length and the time sent, the sender's picture with a microphone badge, then "Transcript · 0:00–0:20" and the words.

This plan was reviewed independently (Opus) on 2026-11-18; the review's 31 points are folded in below.

## Decision D13 (owner, 2026-11-18): voice messages are transcribed on the server

This decision changes D7's Transcription row for **voice messages only**.

- **Where it runs.** A voice message is transcribed by the in-cluster speech model behind the `transcribe` alias (the `asr` workload). The clip is already on the server as the message's attachment. The audio goes from the server to the speech pod inside the cluster and nowhere else.
- **Only inside the deployment.** The job refuses a `transcribe` target that is not local (`target.local`, gateway-llm `egress-targets.ts`). In that case the voice message gets no transcript and shows the reason.
- **The 20-second cut.** Only the first 20 seconds are transcribed: it is a preview, not a record.
- **Consent.** D7 asks for the speaker's own consent before any server transcription. D13 trades that for a **workspace admin switch** (Settings → Workspace, "Write transcripts of voice messages on this server", on by default) and a line in the recording bar's accessible description and in the docs that says voice messages are transcribed on this server. The owner chose this trade on 2026-11-18. Meetings keep D7 as it is.
- **Languages.** Parakeet v3 covers 25 European languages, English among them. It does not cover Arabic, Bangla, Hindi or East Asian languages. Some teams speak Bangla and Arabic (MISTAKES 2026-11-06), and the old in-browser Whisper handled those. Phase 32 follows the owner's choice (Parakeet), and the report to the owner says this plainly so the owner can decide on a second model for those languages.

PLAN.md §3 gets a D13 row. D7's Transcription row and its "self-hosted Whisper server" wording point to D13. `docs/engineering/conventions.md` (the transcription line) changes the same way. PLAN §7 gets a Phase 32 row.

## A. The speech server: Parakeet v3 replaces faster-whisper-tiny (`deploy/images/asr`)

- **The image.** `python:3.12-slim`, pinned by digest, with Debian's `ffmpeg` (a GPL build: list it in the third-party notices). The image also has `onnx-asr[cpu,hub]` (MIT), `onnxruntime`, `fastapi`, `uvicorn` and `numpy`, each pinned with hashes in `requirements.txt`.
- **The model.** `istupakov/parakeet-tdt-0.6b-v3-onnx`, int8 files, downloaded at build time. At run time `HF_HUB_OFFLINE=1`. Licence CC-BY-4.0 (NVIDIA): credit it in `docs/deploy.md` and the notices.
- **The server (`server.py`).**
  - `GET /health` answers at once, even while a clip is being worked on.
  - `GET /v1/models`.
  - `POST /v1/audio/transcriptions` takes `file`. It accepts any `model` value (the alias is bound to an old whisper id on the live site) and ignores `language`. It answers `{text, language: null, duration}` for `json` and `verbose_json`.
- **The fixed cut rule.** LiteLLM runs with `drop_params: true`, so an extra form field never reaches the pod. Instead:
  - input that is not WAV (a voice clip) is cut at **20 s**;
  - WAV input (meeting chunks, at most 30 s) is cut at **30 s**.
- **Decoding.**
  - The upload is capped at 8 MiB and written to a tmpfs file (`/dev/shm`). A Safari mp4 with its index at the end cannot be read from a pipe.
  - `ffmpeg -t <cut> -i <file> -ac 1 -ar 16000 -f s16le -` produces raw samples, which numpy turns into float32.
  - The text comes from `onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", quantization="int8", sess_options=…)`, then `.recognize(arr, sample_rate=16000)`.
  - Recognition runs in a worker thread behind a semaphore of 1, with a small queue (a busy server answers 429). Threads are set through `sess_options` from `ASR_THREADS` (default 4).
- **Chart changes.**
  - `asr.yaml` swaps the speaches environment for `ASR_THREADS`.
  - The values.yaml comment ("fallback for a device too weak") and the requests and limits come from the spike's measurement (expected limit about 2.5Gi).
  - P32-09 checks that the live `transcribe` provider is marked local; it is rebound if needed.

## B. Data: shared schema (D1), migration (D3)

**`VoiceMeta.transcript`.** It gains `pending`, `server` and `failed`. `device`, `edited` and `none` stay for old messages. New optional fields:

| Field | Value |
|---|---|
| `transcriptEndMs` | The end of the transcribed range: at most 20000, and never more than the clip. |
| `transcriptNote` | A plain reason when the state is `failed` or the model is not available. At most 200 characters. |

There is no transcript text in the meta: the **message body is the transcript**, as today.

**What the server decides.** The server sets these fields itself and ignores any `transcript`, `transcriptEndMs` or `transcriptNote` the client sends:

- `pending` when the workspace switch is on;
- `none` when it is off.

An old client that still sends `device` with words is accepted, so a cached bundle can still send: the server keeps its words and marks them `device`.

**The body.** A new voice message's body is `voiceFallbackBody(durationMs)` ("Voice message (0:42)"). When the transcript arrives, the server writes the transcript text as the body and `bodyPlain`, with " …" added when the clip is longer than the range, and leaves `editedAt` null.

**The workspace switch.** A setting on the workspace (schema, migration, `GET` and `PUT` route for admins, the Settings → Workspace row), default on.

**The message-versions trigger.** A migration makes the trigger (channels 0009) skip a body change where `edited_at` did not change, so the stand-in line never shows as an earlier version.

**Old clients.** `voice: VoiceMeta.optional().catch(undefined)` means an old bundle drops the meta of a `pending` or `server` message and draws a plain file until it reloads. That is accepted and written in the docs.

## C. Server: queue, worker, door, event, retry

**The post route** (channels). When `voice` is present and the switch is on, the route stores the message as `pending`. It enqueues `ctx.jobs.enqueue(tx, 'voice-transcribe', {messageId}, {dedupeKey: 'voice:<messageId>'})` in the same transaction and pushes the message as today.

**The worker** is `ctx.jobs.register('voice-transcribe', handler, {detached: true, concurrency: 2, maxAttempts: 3})`. It works in three steps:

1. In one short transaction it reads the message, its clip file and the switch. It does nothing if the message is deleted, is no longer `pending` (an author edit makes it `edited`), or the switch is now off (then it sets `none`).
2. It reads the clip bytes from storage, with no transaction open.
3. It calls the door.

What it does with the door's answer:

| Outcome | What the worker does |
|---|---|
| `text` | Compare-and-set in one transaction: `UPDATE … WHERE id=$1 AND deleted_at IS NULL AND meta->'voice'->>'transcript'='pending'`. Sets the body, `bodyPlain`, `transcript: 'server'` and `transcriptEndMs`. On success it emits the event and pushes `message.edited` with the new message; `editedAt` stays null, so no edited mark is drawn. |
| `unavailable` that may pass (busy, timeout, the model not answering) | **Throws**, so the queue retries. On the last attempt (`job.attempt === maxAttempts`) it writes `failed` with the note, using the same compare-and-set. |
| `refused`, or not set up / not local | Writes `failed` at once with the note, and marks the note as one that cannot be retried. |
| The clip file is gone | Same as `refused`. |

**The door `transcribeClip`.** gateway-llm sits beside `transcribe`, and the SDK type lives in `packages/sdk/src/transcribe.ts`. It does **not** reuse the WAV checks. It works in three steps:

1. **Preflight** (`loadEgress`, the budgets and egress check) in one short transaction. A target that is not local is refused here.
2. **The fetch**, with no transaction open: 8 MiB cap, the original content type, a 60 s timeout.
3. **The spend line** (purpose `transcribe`, cost 0, since the model is always local) in a second short transaction.

It never throws. With `fakeAsrEnabled`, it answers a fixed scripted text ("This is a test voice message.") after a short delay.

**The event** is `channel.message.transcribed` (`domain.noun.verb`). It has a Zod schema in `packages/shared/src/events/`, is registered, and its payload carries ids, the state and the range, never the words. It gets an audit MAPPERS entry only if the audit list already covers channel message events. Its contract test runs in `test:events`.

**Bots and memory.**

- **Bot router** (runtime-hermes `router-subscribe.ts`). A posted voice message that is `pending` is **not** routed on `channel.message.posted`. It is routed once, on `channel.message.transcribed`, with the transcript as its text. On `failed` it is routed with the stand-in line, as today's `none` message.
- **Memory consumers** (memory `consumers.ts`). They consume `channel.message.transcribed` like an edit.
- **Bridges.** They send the stand-in line. Documented.
- **Mentions.** The server does not run `syncMessageRefs` on machine-written text, so a spoken "@name" notifies nobody. Documented.

**The retry route.** `POST /api/messages/:id/voice/transcribe` works like this:

- only the author can use it;
- it works only from `failed` with a note that can be retried;
- it is refused when the switch is off or the model is not set up;
- it re-queues the job;
- it is rate-limited in process memory, at 3 per message per hour (conventions).

## D. Web: the recording bar (owner's second picture)

The mic button stays where it is, offered when the text box is empty. Pressing it, or holding it on a phone, starts recording. While recording, the composer's text row and formatting toolbar are replaced by one rounded bar. From left to right:

| Item | What it is |
|---|---|
| Delete recording | A trash ProIcon button. |
| The live indicator | A red dot (pulsing; a still dot under `prefers-reduced-motion`) and the time `0:07`, which excludes paused time. |
| The waveform | Thin bars fed by the existing meter (one reading every 80 ms) that scroll left, with a fixed number of bars. Under reduced motion it does not scroll and only the newest bars change. |
| Pause / Resume recording | One button. |
| Send voice message | A round button in the ok colour with the send icon. |

Paused:

- the dot is grey, the waveform stops and Resume shows;
- Send works while paused;
- at 5:00 recording stops and the bar waits, paused, for Send or Delete.

Keys and hold:

- Esc deletes and puts focus back in the text box;
- hold-to-record keeps slide-left to cancel, and releasing sends.

**Pause in `capture.ts`.**

- `RecorderLike` gains `pause()`/`resume()` (MediaRecorder's own).
- Elapsed time leaves out paused spans.
- Meter readings stop while paused.
- Unit tests cover these.

**Sending.**

- **Right after Send.** Send hands the clip to the store, which shows a pending row **at once** (a new "uploading" pending kind that holds the blob, peaks and length, drawn with the waveform and "Sending…"), uploads the file, then posts the message.
- **When the upload fails.** The row shows "Not sent · Try again · Delete", the same as a failed text send.

**What is removed.** The device path goes entirely:

- `transcribe.ts` and `TranscriptRun`;
- the preview editor in `Recorder.tsx`;
- `late.ts` ("Send without waiting");
- `store.addLateTranscript` and `lateTranscripts`;
- `WritingOut.tsx`;
- the message menu's "Add a transcript" (MessageRow).
- Their tests are removed with them.

The browser speech engine (`clients/web/src/speech/`) stays for meetings. Codegraph is checked before deleting each piece.

**Look.** Tokens and ProIcons only (D11). The bar has AA contrast in light and dark for all four palettes, and no horizontal scroll at 390 px.

## E. Web: the voice message (owner's fourth picture)

**The player row.**

- The play or pause button.
- The waveform (the `peaks`), with a **dot** at the play position.
- Under the waveform's left end, the length, or the position while playing.
- Under its right end, the time the message was sent.
- At the right, the sender's avatar with a small microphone badge. It is green until this reader has played the message and grey after. The accessible name says "not played yet" or "played". The played state is kept in local storage per message, capped at the last 500 ids and read and written in try/catch.
- The existing speed button stays, placed after the time.

**Under the player.**

| State | What shows |
|---|---|
| `pending` | "Writing the transcript…" with a small spinner (a still dot under reduced motion). `aria-live="polite"` is on the author's own message only. |
| `server` | "**Transcript · 0:00–0:NN**" (the real range), then the message **body** as the text. When the clip is longer than the range, a quiet "First 20 seconds" follows. After an author edit (`edited`), the heading reads "Transcript (edited)". |
| `failed` | "No transcript" and the note. "Try again" shows only for the author, only when the note can be retried. |
| `none`, `device`, `edited` (old messages) | As today, minus "Add a transcript". |

The body is drawn once: inside the transcript block, not again as message text.

**Live update.** The `message.edited` push updates the channel and thread views in place. The Threads inbox shows the transcript the next time it loads: the thread title follows `body_plain` through the existing trigger. It has no live push, and this is written in the docs.

## F. Tasks and tests

| ID | Task |
|---|---|
| P32-00 | Spike: build the image on the devbox, then measure time and memory for a 20 s English clip, a 20 s clip in another European language, silence, and two clips at once. Results go in `docs/spikes/parakeet-measured.md`. |
| P32-01 | The asr image and chart (A). A container test **run on the devbox, not in CI** (the image is about 1.4 GB): `/health` answers during recognition; `/v1/models`; `e2e/fixtures/speech/hello.wav` and a webm/opus clip give the expected words; a 25 s webm returns `duration` 20; a 25 s WAV is cut at 30 s, not 20; an mp4 with the index at the end decodes; 8 MiB + 1 is refused; a third request at once gets 429. |
| P32-02 | Schema and route rules (B). Tests: the server sets the state and ignores client fields; an old `device` send still works; the switch on and off; the setting route (admins only); the versions trigger writes no row for a transcript write. |
| P32-03 | The door `transcribeClip` (C). Tests with a fake fetch: local only, no transaction across the fetch, the cap, the outcomes, the spend line, fake ASR. |
| P32-04 | The worker, event, router, memory and retry (C). DB integration tests with fake ASR: pending → server; transient → retry → failed on the last attempt; refused → failed at once; compare-and-set loses to a delete and to an author edit; the switch turned off after the post; the retry route rules. The bot router routes once, on the transcribed event. Memory takes the new text. Event contract test. |
| P32-05 | The recording bar and capture pause (D). jsdom and unit tests: start, pause, resume, elapsed time without pauses, delete, Esc, send while paused, the 5:00 stop, hold and slide-left cancel, the uploading pending row and its failure. Remove the preview, late and "Add a transcript" tests. |
| P32-06 | The voice message view (E). jsdom tests for each state, the live update from a `message.edited` push, the badge's played state and its storage cap, and that the body is not drawn twice. |
| P32-07 | Playwright. Rewrite `e2e/channels/voice-message.spec.ts`, `voice-mobile.spec.ts` and `room-voice-message.spec.ts` on Chromium's fake microphone (`--use-file-for-fake-audio-capture=e2e/fixtures/speech/hello.wav`) with fake ASR: record, pause, resume, send, "Writing the transcript…", the transcript, the thread view, 390 px. Refresh the composer baselines. |
| P32-08 | Pictures in Graphite dark and Linen light at 1440 and 390 px: the bar recording and paused; the message pending, with a transcript and failed. Saved to `temp/screenshots/p32/`. |
| P32-09 | Deploy, then a live check with the real Parakeet: confirm the provider is local; record a real English clip in a browser on the live site; the transcript arrives and reads sensibly; a clip over 20 s shows "0:00–0:20"; a voice DM to a bot gets an answer to the words. Record the time from send to transcript in STATUS. Remove the old asr image from k3s. Docs: `docs/plugins/channels.md`, `docs/deploy.md` (Speech to text), the notices, MISTAKES as needed. |

## Risks

- **Disk.** The image is about 1.4 GB and replaces a 1 GB one (the disk is at 83%). Import one image at a time and remove the old one after the roll.
- **CPU.** At most two jobs at once, each with a semaphore of one in the pod. A queue only delays transcripts; it never blocks a send.
- **Languages outside Parakeet's 25.** They give poor text. The owner is told (D13).
