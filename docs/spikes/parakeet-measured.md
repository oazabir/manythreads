# P32-00 spike record · Parakeet TDT 0.6B v3 on the devbox CPU

Question (PLAN P32-00, decision D13): how fast is the speech server of voice messages on the devbox CPU, how much memory does it need, and does it take what a browser sends?
Status: **built and measured on one machine only** (the devbox: 8 threads of an AMD Ryzen 5 3600, no GPU, shared with the live site, load average 1.3 to 2.4 during the runs). Nothing was deployed or imported into k3s.

## Decision

The image of `deploy/images/asr` (Dockerfile, `server.py`, pinned `requirements.txt`) does what plan section A says. The numbers below set the chart's resources:
**request 1 CPU and 1792 MiB, limit 2560 MiB, `ASR_THREADS` 4.** The plan's "about 2.5 Gi" limit holds.

## Method

- The image was built as `manythreads/asr:p32-dev` and run with `docker run` on a loopback port. First with no limits and `ASR_THREADS=4` (the default); then again with `--cpus 2 --memory 2560m -e ASR_THREADS=2` to see a smaller pod.
- Wall time is curl's `time_total` for one request (upload, decode, recognition, answer), taken over the loopback. The server's own log splits it: decoding with ffmpeg took 0.1 s for a 20-second webm; the rest is recognition.
- Peak memory is the highest `docker stats` reading (polled in a loop while the request ran) and, at the end of a session, the container's `memory.peak` (cgroup v2), which is the true peak of the whole session.
- Clips (all kept outside the repository except the two English fixtures):
  - English: `e2e/fixtures/speech/nadia.wav` + `rafi.wav` + `nadia.wav` joined (24.8 s, real read-aloud speech, LibriSpeech, CC BY 4.0), cut to 20 s or 25 s, written as WAV, webm/opus (24 kbit/s) or mp4/aac.
  - Another European language: German, two read-aloud clips of the Multilingual LibriSpeech test set (`facebook/multilingual_librispeech`, German, CC BY 4.0; LibriVox readings) joined and cut to 20 s, as WAV and webm/opus.
  - Silence: 20 s of digital silence, as WAV and webm/opus.
- Every number is **one machine and a handful of runs, not a benchmark**. They give the order of magnitude, not a promise.

## Numbers (measured)

Speed, 4 threads, no CPU limit:

| Case | Wall time | Peak memory (`docker stats`) |
|---|---|---|
| English 20 s webm/opus, first clip after start | 2.2 s | 1.39 GiB |
| English 20 s webm/opus, warm (3 runs) | 1.9 s, 1.6 s, 1.7 s | 1.39 GiB |
| English 20 s WAV | 2.3 s | 1.39 GiB |
| German 20 s webm/opus (first, then warm) | 2.1 s, 1.6 s | 1.39 GiB |
| German 20 s WAV | 1.8 s | 1.39 GiB |
| Silence 20 s webm/opus | 1.6 s | 1.39 GiB |
| Silence 20 s WAV | 1.6 s | 1.39 GiB |
| English 25 s webm (cut to 20 s, `duration` 20) | 1.8 s | 1.39 GiB |
| English 25 s WAV (kept whole, `duration` 24.76) | 2.7 s | 1.48 GiB |
| English 40 s WAV (cut at 30 s) | 2.6 s | 1.51 GiB |
| mp4/aac 20 s, index (moov) at the end | 2.3 s | 1.48 GiB |
| mp4/aac 20 s, index first (faststart) | 2.3 s | 1.48 GiB |
| Two clips at once (English and German, 20 s webm) | first 2.4 s, second 4.2 s | 1.48 GiB |
| Two 40 s WAV clips at once (the worst case the server allows) | 6.6 s for the second | 1.63 GiB |
| Three at once | two served (2.2 s and 4.4 s), the third got **429 after 7 ms** | 1.48 GiB |

Smaller pod (2 CPUs, 2 threads, memory limit 2560 MiB, not once killed):

| Case | Wall time | Peak memory |
|---|---|---|
| English 20 s webm (2 runs) | 2.2 s, 2.2 s | 1.37 GiB |
| German 20 s webm | 2.2 s | 1.37 GiB |
| Two at once (20 s webm) | first 2.1 s, second 4.1 s | 1.37 GiB |
| English 40 s WAV (cut at 30 s) | 3.3 s | 1.48 GiB |

- **Real-time factor** about 0.08 to 0.11 (20 seconds of speech in 1.6 to 2.2 s), so a 20-second voice message is written out about two seconds after it reaches the pod. The first clip after a start was only 0.3 s slower than the warm ones.
- **Memory:** 1.26 GiB at rest (model loaded, one clip done), 1.39 GiB for a 20-second clip, at most **1.63 GiB** (1.75 GB by `memory.peak`) with two 30-second WAV clips in hand (one working, one waiting; the uploads sit in tmpfs, 8 MiB at the most each). The 2560 MiB limit leaves about 50% headroom.
- **Starting the server** loads the model in 2.4 s (the files are in the image); `/health` answers from then on.
- **Silence costs as much time as speech** (no voice-activity step): 1.6 s for 20 s. It gives an empty text, which the worker must handle (a voice message with no words).
- **Two clips at once take twice as long, one after the other** (the semaphore of one); the answer to the second is not slower than 2 times one clip. A third at once is refused at once with 429 and a `Retry-After` header.
- **Two threads are nearly as fast as four** (2.2 s against 1.6 to 1.9 s for 20 s). The cluster node has no spare CPU to waste, so the chart's default may be lowered with `asr.threads: 2` if the pod competes with other work.

## What the words look like

- English (the three sentences of the fixtures, read aloud): correct, with capitals and punctuation, except for rare names (`Kaliko` came out as "Galico" or "Calico", `Ruggedo` as "Brigado"). With the 20-second cut the text ends in the middle of a sentence ("... needed undisturbed rest"), as designed.
- German (Multilingual LibriSpeech, a clear reading): readable but not clean. About 4 words of 35 are wrong ("meine Gedanken **by** Ihnen" for "bei ihnen", "**Herr Zauben**" for "herzaubern", "herfurt" for "herführt"). The int8 model is weaker outside English; this is the quality to expect from other European languages, and Parakeet does not cover Arabic, Bangla, Hindi or East Asian languages at all (D13).
- The model ignores a `language` setting; it detects the language itself. The server answers `"language": null`.

## What the browser and phone clips needed

- **webm/opus** (Chromium, Firefox) and **mp4/aac** (Safari) both decode and give the same words as the WAV. An mp4 written with the index (`moov`) at the end decodes, because the server writes the upload to a tmpfs file (`/dev/shm`) and gives ffmpeg the file, not a pipe. A pipe fails on such a file.
- The server hands ffmpeg only what its first bytes name (WAV, webm/mkv, ogg, mp4/mov, flac, mp3, aac) and forces that demuxer with `-f`, so a text file that pretends to be a playlist (`#EXTM3U`, which ffmpeg would follow to other files) is refused with 400 and never opened.

## Image

- `manythreads/asr:p32-dev` was built in about 3 minutes (apt, pip with hashes, one model download of 640 MB) and holds **1.4 GB** of files (`du` of the root: 1408 MB; the model 640 MB, Debian's ffmpeg and its libraries about 450 MB, the Python packages 213 MB). Docker's own listing shows 2.2 GB for it, because of how this Docker (containerd snapshotter) counts layers; the root file system is the number that matters for the k3s import and the disk.
- The base `python:3.12-slim` is Debian 13 (trixie), ffmpeg 7.1. The model is fetched from Hugging Face by onnx-asr at build time without a revision pin (onnx-asr does not take one); the build prints no revision, so a rebuild months later may fetch a newer model file. The base and the Python packages are pinned by digest and by hash.

## Not measured

- A phone, other CPUs, a pod under the real node load, a clip of 5 minutes (the cut makes it irrelevant: only the first 20 seconds are read), a second language besides German, noisy speech, and the real LiteLLM path (it runs in P32-09).
