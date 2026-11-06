# P14-16 spike record · on-device speech to text

Question (PLAN P14-16): can a browser write out a voice message on the sender's own device, with which model, how fast, and on which devices?
Status: **built and measured on one machine only** (the devbox, CPU, no GPU). Everything else in this page is marked as unmeasured. Nothing here was run on a phone, a laptop with a graphics card, or in Safari or Firefox.

## Decision

- **Engine:** Whisper through `@huggingface/transformers` (ONNX Runtime Web), in a Web Worker, so the page never freezes. WebGPU when the browser has it, WASM (the processor) otherwise. Silero VAD cuts silence and splits long clips.
- **Models in the web image:** `whisper-tiny` and `whisper-base`, both quantised `q8`, plus Silero VAD and the ONNX Runtime WASM file. They are served by our own web image under `/models/<name>/<revision>/`, pinned by sha256 in `clients/web/models.lock.json`, never from a CDN at run time, and kept by the service worker (cache-first, keyed by the revision).
- **Which model where:** one table in `clients/web/src/speech/device.ts` (`DEVICE_TABLE`), copied below.
- **The sender corrects the words** before sending, and "Send without waiting" never blocks on a slow device. That is why a slow result is acceptable.

## Method

- Machine: the devbox (the box that builds and hosts manythreads), headless Chromium driven by Playwright, **WASM, single thread** (no cross-origin isolation, so ONNX Runtime does not use threads; see Risks in the plan).
- Clip: one English clip of **13.06 s**. Timings are wall-clock inside the worker, taken by the F9-3 coder through `/dev/speech` (`clients/web/src/pages/DevSpeech.tsx`), which also prints the real-time factor, JS heap and word error rate.
- "Cold" is a fresh worker that opens the model files and builds the ONNX session. "Warm" is the next clip on the same worker (the model is already in memory). "Real-time factor" (RTF) is decode time divided by clip length; below 1 means faster than the recording.
- Every number is **one machine, a handful of runs, not a benchmark**. They tell us the order of magnitude, not a promise.

## Numbers (measured)

| Model (q8, WASM, 1 thread) | Download | Cold total | Warm total | RTF warm | Voice-activity finder |
|---|---|---|---|---|---|
| `whisper-tiny` | 43.6 MB (model files) | 7.0 to 7.6 s | 4.7 s | 0.36 | 0.4 s |
| `whisper-base` | 79.7 MB (model files) | 13.6 s | 11.5 s | 0.88 | 0.4 s |

The coder's note rounded base to "about 0.8x"; 11.5 s over 13.06 s is 0.88, which is the figure used here.

Other files in the image (sizes from `models.lock.json`): Silero VAD 2.2 MB, ONNX Runtime WASM 21.6 MB (shared by both models). One download for a phone that only ever uses tiny is therefore about 43.6 + 2.2 + 21.6 = **67 MB**; the first-use note in the recorder says "about 40 MB" for the model itself. A device that goes to base fetches about 80 MB more. The web image carries all of it (about 147 MB).

What these say:

- A tiny clip of 13 s is written out in about 5 s on this CPU, so a typical 10 to 30 s voice message is done by the time the sender has read it. A 5-minute message (the cap) would take roughly 1.8 minutes at 0.36, and 4.4 minutes with base at 0.88 on this machine.
- base is more than twice as slow as tiny here. Without a GPU it is not worth it; the table keeps it for devices with WebGPU only.

## Decision table (what `device.ts` does today)

| Device class | How the check sees it | Model | Expected feel (estimate, see below) |
|---|---|---|---|
| Laptop or desktop with WebGPU, at least 4 GB (as the browser reports it) | adapter present, `deviceMemory >= 4`, not a phone | `base` | **UNTESTED.** Expected faster than real time; to be measured |
| Laptop or desktop without WebGPU, 4 or more threads | `hardwareConcurrency >= 4`, memory unknown or `>= 2` GB | `tiny` | about the devbox row: RTF near 0.4 for a CPU of that class |
| Phone (coarse pointer and width under 768 px), 4 or more threads, memory unknown or `>= 2` GB | `phone = true` caps the choice at `tiny` | `tiny` | **UNTESTED.** A phone CPU is usually slower than the devbox; a guess is RTF 1 to 3, which is why sending without waiting exists |
| Fewer than 4 threads, or under 2 GB | | none | "This device is too slow to write out voice messages." The clip goes without words; the sender can add them later from another device |
| No Worker or no AudioContext | `hasSpeechPlatform()` false | none | same sentence |

Notes: Safari and Firefox do not report `deviceMemory`, so "unknown" passes the memory test there. The weakest supported device is therefore "4 threads and 2 GB, if the browser says"; **nothing was measured on such a device**, so that line is a design choice, not a finding.

## Not measured (do not treat as known)

- **WebGPU: untested.** No WebGPU adapter exists on the devbox, so the `base` row and every fp16/q4f16 option are unmeasured. The models shipped are q8 for both backends until a GPU run shows something faster.
- **Bangla: untested.** Bangla is a stated test language, but no Bangla clip was run. Whisper tiny and base are known to be weak on Bangla; expect a high word error rate and plan for the sender's correction step to matter. The language is found by the model (`languageFromLogits`), not assumed to be English.
- **Word error rate: not measured.** The folder `e2e/fixtures/speech/` holds only a synthetic clip (`hello.wav`, no speech) because no licensed speech recordings and no text-to-speech tool were available; see its `LICENCE.md`. So no WER figure exists for tiny or base, in English or in any other language. `/dev/speech` computes WER once real clips and reference texts are added.
- **Other browsers:** Safari (records `audio/mp4`, no `deviceMemory`), Firefox (no `deviceMemory`) were not run.
- **Memory:** JS heap was shown on the bench page; the process memory of a phone tab under base was not measured (the plan guesses 500 MB for base).
- **Multithreaded WASM:** not tried. It needs cross-origin isolation (COOP and COEP headers), which the app does not send; it is a P15 question.
- **Small and the distilled models:** not measured, not shipped (small is about 250 MB; distilled variants are English-only).

## What the owner must measure

Open `https://manythreads.kahf.to/dev/speech` (signed in) on each device below, pick a clip you recorded yourself (the page can record), run tiny and base on the processor and on the graphics card, and paste the table the page prints (model, backend, load ms, decode ms, clip ms, real-time factor, JS heap, WER if you typed the reference text).

1. **A mid-range Android or iPhone, in its normal browser, on mobile data.** Also note how long the first download of the model takes and whether the page survives it.
2. **A laptop with a graphics card (Chrome or Edge).** The page's "This device" line should say WebGPU: yes. This decides whether `base` is worth shipping and whether the thresholds in `DEVICE_TABLE` move.
3. **A Bangla clip of your own voice**, on any device, to see what the words look like before correction.
4. **Safari on a Mac or iPhone**, and **Firefox**, one run each: does it record, does the model load, is the language found.

If the numbers show tiny is too slow on phones (RTF over about 3), change `DEVICE_TABLE` in `clients/web/src/speech/device.ts` (and this page's table) in the same commit.

## Where the tests stand

Browser tests (`e2e/channels/voice-*.spec.ts`) use the fake engine (`VITE_MANYTHREADS_FAKE_ASR=1`), a fixed sentence for every clip, and Chromium's fake microphone fed from `e2e/fixtures/speech/hello.wav`. They prove the recording, preview, correction, sending, playback and search flow, **not** that the real Whisper model hears words. The real engine was run only through the bench page by the coder, and in the live check (PLAN F9 section "Live check").

**Live check 2026-11-06 (c01b68de, `e2e/screens/task.verify-f9.shots.ts`).** The real tiny engine ran on https://manythreads.kahf.to in the devbox's Chromium (WASM, 8 threads) on the synthetic `hello.wav`: first use 9.9 s for a 3 s clip, warm 3.7 s. `/dev/speech`, 6 s clip: tiny/WASM total 6.07 s (RTF 0.71, load 1.8 s); base/WASM total 15.0 s (RTF 1.45, load 6.4 s). The clip is not speech, so the words ("Okay.", "(humming)", base chose Japanese) say nothing about accuracy. Everything in "Not measured" above is still not measured.
