/*
 * The live form of the on-device speech engine (PLAN P15-06). `engine.ts` turns a finished clip into words; this file keeps a microphone running and turns it
 * into lines while the person talks:
 *   a PcmSource      gives the microphone as 16 kHz mono samples (the person's OWN track, nothing of the room);
 *   the segmenter    (vad.ts) cuts the stream into chunks at a pause, at most 28 seconds each;
 *   a Recognizer     writes a chunk out (the Whisper worker of P14-16, reused, so one model in memory for voice messages and rooms alike);
 *   the transcriber  below ties them together: a partial line about once a second while someone talks, a final line when the chunk closes.
 * Nothing is sent anywhere from here: the lines go to `onLine`, and `meetings/engine.ts` decides what to do with them. Everything with a browser in it is handed in
 * (`createContext`, the recognizer), so the logic is unit-tested in Node with a stand-in.
 */
import { installWhisperWorker } from './client';
import { getSpeechEngine } from './engine';
import { TOO_WEAK_REASON } from './device';
import { SPEECH_SAMPLE_RATE, resample } from './resample';
import { createStreamingSegmenter, type FrameClassifier, type StreamChunk, type StreamSettings } from './vad';
import { SpeechError, type SpeechProgress } from './types';

export const STREAM_SAMPLE_RATE = SPEECH_SAMPLE_RATE;

/** The sentence a person reads when their device cannot keep up (PLAN P15-06). */
export const TOO_SLOW_MESSAGE = 'This device is too slow to transcribe. Ask your admin about server transcription, or join without it.';
export const SPEECH_FAILED_MESSAGE = "Couldn't write out what you said. Transcription stopped for you.";

// ---- the microphone as samples --------------------------------------------------------------------------------------------------------------

/** A source of 16 kHz mono samples. `start` resolves once samples are flowing. */
export interface PcmSource {
  start(onPcm: (samples: Float32Array) => void): Promise<void>;
  stop(): void;
}

/** The parts of the page's audio system the track source uses, so a test does not need a browser. */
export interface AudioContextLike {
  readonly sampleRate: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: MediaStream): { connect(to: unknown): unknown; disconnect(): void };
  createGain(): { gain: { value: number }; connect(to: unknown): unknown; disconnect(): void };
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): {
    onaudioprocess: ((e: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
    connect(to: unknown): unknown;
    disconnect(): void;
  };
}

const browserContext = (): AudioContextLike => {
  const g = globalThis as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctx) throw new SpeechError('unavailable', "This browser can't listen to the microphone.");
  return new Ctx();
};

/**
 * The person's own microphone track as 16 kHz samples. The track is read, never changed or stopped (the caller gives a clone). A script processor does the reading:
 * it is the one way every browser lets a page see raw samples without serving a separate worklet file, and at 4096 samples a block it is cheap.
 */
export function createTrackSource(track: MediaStreamTrack, deps: { createContext?: () => AudioContextLike } = {}): PcmSource {
  let ctx: AudioContextLike | null = null;
  let nodes: { disconnect(): void }[] = [];
  return {
    async start(onPcm) {
      const c = (deps.createContext ?? browserContext)();
      ctx = c;
      const source = c.createMediaStreamSource(new MediaStream([track]));
      const processor = c.createScriptProcessor(4096, 1, 1);
      // a script processor only runs when it leads to the speakers, so it leads to a gain of zero: nothing is played
      const mute = c.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (e) => {
        const block = e.inputBuffer.getChannelData(0);
        onPcm(resample(block.slice(), c.sampleRate, STREAM_SAMPLE_RATE));
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(c.destination);
      nodes = [source, processor, mute];
      await c.resume();
    },
    stop() {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          // already apart
        }
      }
      nodes = [];
      const c = ctx;
      ctx = null;
      if (c) void c.close().catch(() => undefined);
    },
  };
}

// ---- writing a chunk out ----------------------------------------------------------------------------------------------------------------------

export interface RecognizeResult {
  text: string;
  language: string | null;
}

export interface Recognizer {
  /** Writes out 16 kHz mono samples. Rejects with a `SpeechError`. */
  transcribe(samples: Float32Array, options: { language?: string; onProgress?: (p: SpeechProgress) => void }): Promise<RecognizeResult>;
}

export type RecognizerChoice = { ok: true; recognizer: Recognizer } | { ok: false; reason: string; tooWeak: boolean };

/**
 * The recognizer for this device: the Whisper worker of voice messages, handed samples directly (no encoding and decoding in between). `ok: false` says in one
 * plain sentence why not; `tooWeak` marks the case the page answers with the "too slow" message and the server offer.
 */
export async function chooseRecognizer(): Promise<RecognizerChoice> {
  // the worker must be plugged in before the engine is chosen: the choice is remembered, and without a backend it would be remembered as "not ready"
  const backend = installWhisperWorker();
  const engine = await getSpeechEngine();
  if (engine.kind === 'none') return { ok: false, reason: engine.reason ?? TOO_WEAK_REASON, tooWeak: engine.reason === TOO_WEAK_REASON };
  const model = engine.model;
  return {
    ok: true,
    recognizer: {
      async transcribe(samples, options) {
        if (engine.kind === 'whisper' && (model === 'tiny' || model === 'base')) {
          const t = await backend.transcribe(model, { samples, sampleRate: STREAM_SAMPLE_RATE }, options);
          return { text: t.text, language: t.language };
        }
        // the test engine: no model, the same words for every clip (the page's own fake does not come this way)
        const t = await engine.transcribe(encodeWav16(samples), options);
        return { text: t.text, language: t.language };
      },
    },
  };
}

// ---- the transcriber ------------------------------------------------------------------------------------------------------------------------

/** One line as the transcriber finds it, on the meeting clock. A partial line (`final: false`) shares its `id` with the final line that replaces it. */
export interface StreamLine {
  id: number;
  text: string;
  startMs: number;
  endMs: number;
  final: boolean;
  lang: string | null;
}

export type StreamStatus =
  | { kind: 'listening' }
  /** The speech model is being fetched or readied; `fraction` is 0 to 1. */
  | { kind: 'loading'; fraction: number }
  /** The device cannot keep up: finished chunks wait for longer than `maxBacklogMs`. The transcriber has stopped. */
  | { kind: 'too_slow'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' };

export interface LiveTranscriberOptions {
  source: PcmSource;
  recognizer: Recognizer;
  /** Milliseconds on the meeting clock right now. */
  now(): number;
  onLine(line: StreamLine): void;
  onStatus?(status: StreamStatus): void;
  /** Force a language ("bn"); by default the model finds it from the first chunk and the transcriber keeps it for the next few. */
  language?: string;
  /** At most one partial job is started in this time. */
  partialEveryMs?: number;
  /** Only the newest part of a long chunk is written out for the partial line. */
  partialWindowMs?: number;
  /** Finished chunks waiting longer than this (milliseconds of audio) mean the device is too slow. */
  maxBacklogMs?: number;
  /** Chunks in a row the model failed on before the transcriber gives up. */
  maxFailures?: number;
  isSpeech?: FrameClassifier;
  settings?: Partial<StreamSettings>;
}

export interface LiveTranscriber {
  start(): Promise<void>;
  /** Stops listening, writes out what is left and resolves when every finished chunk has been delivered. With `discard` what is left is thrown away unwritten and nothing more is delivered. */
  stop(options?: { discard?: boolean }): Promise<void>;
  /** While muted, nothing the microphone hears is kept; the chunk being spoken is ended first. */
  setMuted(muted: boolean): void;
}

/** How often the language is found again instead of reused (a room that changes language is followed within this many chunks). */
const LANGUAGE_REFRESH_EVERY = 8;

export function createLiveTranscriber(o: LiveTranscriberOptions): LiveTranscriber {
  const partialEveryMs = o.partialEveryMs ?? 1000;
  const partialWindow = Math.round(((o.partialWindowMs ?? 12_000) * STREAM_SAMPLE_RATE) / 1000);
  const maxBacklogMs = o.maxBacklogMs ?? 45_000;
  const maxFailures = o.maxFailures ?? 3;
  const status = (s: StreamStatus): void => o.onStatus?.(s);

  const finals: { chunk: StreamChunk; startMs: number; endMs: number }[] = [];
  let backlogMs = 0;
  let running = false;
  let stopped = false;
  let discarded = false;
  let muted = false;
  let failures = 0;
  let language: string | null = o.language ?? null;
  let chunksSinceLanguage = 0;
  let modelReady = false;
  let drained: (() => void) | null = null;
  // where the end of the samples pushed so far sits on the meeting clock; set at every block, so the clock of the audio never drifts from the meeting's
  let anchorMs = 0;
  let anchorPos = 0;
  // partial lines
  let lastPartialStart = Number.NEGATIVE_INFINITY;
  let lastPartialEnd = -1;
  let lastPartialId = 0;
  let lastPartialText = '';
  let closedUpTo = 0; // the highest chunk id that has closed

  const msOf = (sample: number): number => Math.max(0, Math.round(anchorMs - ((anchorPos - sample) * 1000) / STREAM_SAMPLE_RATE));

  const segmenter = createStreamingSegmenter({
    ...(o.isSpeech ? { isSpeech: o.isSpeech } : {}),
    ...(o.settings ? { settings: o.settings } : {}),
    onChunk(chunk) {
      closedUpTo = Math.max(closedUpTo, chunk.id);
      const durationMs = (chunk.samples.length * 1000) / STREAM_SAMPLE_RATE;
      finals.push({ chunk, startMs: msOf(chunk.startSample), endMs: msOf(chunk.endSample) });
      backlogMs += durationMs;
      if (backlogMs > maxBacklogMs && !stopped) {
        finals.length = 0;
        backlogMs = 0;
        fail({ kind: 'too_slow', message: TOO_SLOW_MESSAGE });
      }
    },
  });

  const fail = (s: StreamStatus): void => {
    if (stopped) return;
    stopped = true;
    finals.length = 0;
    backlogMs = 0;
    o.source.stop();
    status(s);
    settle();
  };

  const settle = (): void => {
    if (!running && finals.length === 0 && drained) {
      const d = drained;
      drained = null;
      d();
    }
  };

  const progress = (p: SpeechProgress): void => {
    if (p.stage === 'model' && !modelReady) status({ kind: 'loading', fraction: p.fraction });
  };

  const noteReady = (): void => {
    if (modelReady) return;
    modelReady = true;
    if (!stopped) status({ kind: 'listening' });
  };

  const failedOnce = (e: unknown): void => {
    failures += 1;
    if (failures >= maxFailures) fail({ kind: 'failed', message: e instanceof SpeechError ? e.message : SPEECH_FAILED_MESSAGE });
  };

  const runFinal = (): void => {
    const job = finals.shift();
    if (!job) return;
    running = true;
    const refresh = language !== null && o.language === undefined && chunksSinceLanguage >= LANGUAGE_REFRESH_EVERY;
    const forced = refresh ? undefined : (language ?? undefined);
    void o.recognizer
      .transcribe(job.chunk.samples, { ...(forced ? { language: forced } : {}), onProgress: progress })
      .then((r) => {
        failures = 0;
        noteReady();
        if (o.language === undefined && r.language) {
          if (r.language !== language || refresh) chunksSinceLanguage = 0;
          language = r.language;
        }
        chunksSinceLanguage += 1;
        const text = r.text.trim();
        if (text !== '' && !discarded) o.onLine({ id: job.chunk.id, text, startMs: job.startMs, endMs: job.endMs, final: true, lang: r.language ?? language });
      })
      .catch((e: unknown) => failedOnce(e))
      .finally(() => {
        backlogMs = Math.max(0, backlogMs - (job.chunk.samples.length * 1000) / STREAM_SAMPLE_RATE);
        running = false;
        pump();
      });
  };

  const runPartial = (): void => {
    const cur = segmenter.current(partialWindow);
    if (!cur || cur.id < lastPartialId || (cur.id === lastPartialId && cur.endSample <= lastPartialEnd)) return;
    if (o.now() - lastPartialStart < partialEveryMs) return;
    lastPartialStart = o.now();
    if (cur.id !== lastPartialId) lastPartialText = '';
    lastPartialId = cur.id;
    lastPartialEnd = cur.endSample;
    const startMs = msOf(cur.startSample);
    const endMs = msOf(cur.endSample);
    running = true;
    void o.recognizer
      .transcribe(cur.samples, { ...(language ? { language } : {}), onProgress: progress })
      .then((r) => {
        noteReady();
        const text = r.text.trim();
        // a result for a chunk that has closed meanwhile is stale: its final line is on the way
        if (text === '' || stopped || cur.id <= closedUpTo || (cur.id === lastPartialId && text === lastPartialText)) return;
        lastPartialText = text;
        o.onLine({ id: cur.id, text, startMs, endMs, final: false, lang: r.language ?? language });
      })
      .catch(() => undefined) // a partial that fails is just a caption that did not appear; the final line decides whether the model works
      .finally(() => {
        running = false;
        pump();
      });
  };

  const pump = (): void => {
    if (running) return;
    if (finals.length > 0) runFinal();
    else if (!stopped && !muted) runPartial();
    else settle();
  };

  const onPcm = (block: Float32Array): void => {
    if (stopped || muted) return;
    anchorMs = o.now();
    anchorPos = segmenter.position + block.length;
    segmenter.push(block);
    pump();
  };

  return {
    async start() {
      stopped = false;
      await o.source.start(onPcm);
      status({ kind: 'listening' });
    },
    stop(options) {
      if (options?.discard) {
        discarded = true;
        finals.length = 0;
        backlogMs = 0;
      }
      if (stopped && !running && finals.length === 0) return Promise.resolve();
      const wasStopped = stopped;
      stopped = true;
      o.source.stop();
      if (!wasStopped) {
        if (!discarded) segmenter.flush();
        // flush may have found the too-slow case, which has already settled
        status({ kind: 'stopped' });
      }
      return new Promise<void>((resolve) => {
        drained = resolve;
        pump();
        settle();
      });
    },
    setMuted(m) {
      if (m === muted) return;
      muted = m;
      if (m) {
        segmenter.flush();
        pump();
      }
    },
  };
}

// ---- WAV ------------------------------------------------------------------------------------------------------------------------------------

/** 16-bit mono PCM samples in a WAV container (a 44-byte header, then the samples). */
export function wavFromPcm16(pcm: Int16Array, sampleRate: number = STREAM_SAMPLE_RATE): Blob {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Float samples (-1 to 1) as a 16 kHz mono 16-bit WAV: what the server fallback takes and what the test engine decodes. */
export function encodeWav16(samples: Float32Array, sampleRate: number = STREAM_SAMPLE_RATE): Blob {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
  }
  return wavFromPcm16(pcm, sampleRate);
}
