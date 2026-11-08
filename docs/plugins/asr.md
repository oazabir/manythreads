# asr (speech to text on the server)

Not a plugin of its own: it is the `transcribe` door of the LLM gateway ([gateway-llm.md](./gateway-llm.md), `packages/plugins/gateway-llm/src/transcribe.ts`) plus a small Whisper server that runs inside the deployment
(`deploy/images/asr`, chart template `deploy/helm/manythreads/templates/asr.yaml`). It exists for two callers in [meetings.md](./meetings.md): a device too weak to write out speech by itself (it uploads its own
audio in chunks, PLAN P15-07), and the note-taker's listener ([media-livekit.md](./media-livekit.md), P15-19). Words from a person's own browser (the normal case) never touch it. Deploy steps: [docs/deploy.md](../deploy.md),
"Speech to text".

## The pieces

| Piece | What it is |
|---|---|
| **speaches** | an open-source (MIT) server that speaks the OpenAI audio API (`/v1/audio/transcriptions`) in front of faster-whisper. The CPU image, pinned by digest (0.8.3), in `deploy/images/asr/Dockerfile`. |
| **The model** | `Systran/faster-whisper-tiny`, baked into the image while it is built (one download from Hugging Face at build time). The pod downloads nothing at run time (`HF_HUB_OFFLINE=1`), so a restart does not depend on the outside. A bigger model is a build argument: `ASR_MODEL=Systran/faster-whisper-base`. About 3.5 GB image, about 1 GB of memory requested. |
| **The workload** | `manythreads-asr` Deployment and Service on port 8000, inside the cluster only, no key. `asr.enabled` in the chart (off by default); profile `asr` in the dev compose file. |
| **The alias** | `transcribe`, one of the gateway's closed set of aliases (`smart fast code local embed vision image transcribe`). It is bound to the model like any other alias, on the Models page. |
| **The door** | `transcribe(tx, request)` in gateway-llm, reached by plugins through the `llm` provider (`LlmTranscriber` in the SDK). |

## What the door does

In order: it checks the audio is one 16 kHz mono 16-bit WAV of at most 2 MB and 30 seconds (otherwise `refused`); a WAV that is only silence answers with empty text and goes nowhere (a small Whisper model invents
words for silence); the `transcribe` alias must be bound (otherwise `unavailable`, "Speech to text is not set up"); then the usual pre-call check runs (the egress preset, the workspace's and the team's budgets, the
guardrails) with the alias's target; then the gateway's `POST /audio/transcriptions` is called with the master key; then a line is written to the spend ledger (purpose `transcribe`, session `meeting:<id>`, priced by
audio minutes, nothing per call for a model inside the deployment; the alias shows in Spend as "Meeting transcription"). **The audio is never stored**: the bytes are sent on and dropped, and the upload route
(`POST /api/meetings/:meetingId/audio-chunks`) writes nothing to disk or storage either.

## The admin step after the first deploy

The chart cannot do this; it is a setting of the workspace. As a workspace admin, on the Models page, bind the alias `transcribe` to a model with provider "openai-compatible", model
`openai/Systran/faster-whisper-tiny` (the name the server lists at `/v1/models`; the `openai/` prefix makes the gateway speak the OpenAI protocol), `api_base` `http://manythreads-asr:8000/v1` (in dev compose,
`http://localhost:8000/v1`), and mark the provider as running inside this deployment (the same flag a local model has). Until it is bound:

- the server fallback answers "Speech to text is not set up" and the app says so;
- **Add note-taker** is disabled in the call bar with the reason "Transcription on the server is not set up. Ask a workspace admin to connect a speech model."

The alias costs nothing per call and is under the workspace's budgets and guardrails like any other.

## Air-gapped preset

Allowed, because the server is inside the deployment. The egress rule judges where a call goes, not what the alias is called: `transcribe` is the one alias other than `local` that the air-gapped preset lets through,
and only when its provider is flagged as running inside the deployment. A `transcribe` model on an outside host is refused like any other outside model ([guardrails-egress.md](./guardrails-egress.md)).

## The stand-in for tests

`MANYTHREADS_FAKE_ASR=1` replaces the Whisper server: the "text" of a chunk is whatever follows the marker `FAKEASR:` in the WAV's data, and empty otherwise. The check and the spend line still happen, so a test sees the
same ledger a real call leaves. It is meant for the end-to-end stacks and the `media-fake` plugin's speak route (`POST /api/test/media/speak`). **The server refuses to start with it when `NODE_ENV=production`**
(`assertFakeAsrAllowed`, called when the gateway-llm plugin registers its provider), so it cannot be left on by accident. The browser has a separate stand-in, `VITE_MANYTHREADS_FAKE_ASR=1`, for the on-device engine.

## Who may use the fallback

A room whose transcription mode is `server`, and only while the workspace's and the team's caps both allow `server` (the lower wins; the workspace default is `on_device`, so the fallback is off until an admin
raises it). Only the sender's own speech, and only after they said yes to "Transcribe my voice"; limit 120 chunks a minute per person.

## Tests

`packages/plugins/gateway-llm/test/transcribe.test.ts` (the checks, the proxy call, the spend line, the stand-in and its refusal in production), `chart-voice.test.ts` (the chart renders the workload only when
`asr.enabled`), `packages/plugins/meetings/test/audio-chunks.test.ts` (consent, caps and room checks before the body is read; nothing stored). What the real model writes for real speech, how slow `tiny` is on the
devbox's CPU with two speakers, and how it behaves in Bangla are live checks, not tests.

## Not verified live yet

That the baked image builds on the devbox and answers `GET /health` and `GET /v1/models`; the accuracy of `tiny` on the two read-aloud clips in `e2e/fixtures/speech`; "catching up" under load. See
[docs/retro/phase-15.md](../retro/phase-15.md).
