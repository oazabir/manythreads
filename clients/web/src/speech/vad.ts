/*
 * Finding the speech in a clip (PLAN P14-16): Silero VAD (a 2 MB model) says, for every 32 ms of audio, how likely it is that someone is
 * talking. From those numbers this file picks the stretches of speech and groups them into windows of at most 28 seconds for Whisper, which
 * cuts out long silences (less to decode, fewer invented words) and splits clips over 30 seconds at a pause instead of in the middle of a word.
 * The picking and grouping are plain functions on numbers; only `createSileroRunner` touches the model library.
 */
import { vadModelId } from './protocol';

export const VAD_SAMPLE_RATE = 16_000;
/** Silero v5 reads 512 samples (32 ms) at a time, after 64 samples of the step before it. */
export const VAD_FRAME = 512;
export const VAD_CONTEXT = 64;
const FRAME_MS = (VAD_FRAME / VAD_SAMPLE_RATE) * 1000;

export const VAD_SETTINGS = {
  /** A frame at or above this starts speech... */
  startAbove: 0.5,
  /** ...and speech goes on until the frames fall below this. */
  endBelow: 0.35,
  /** Speech shorter than this is a click or a cough, not words. */
  minSpeechMs: 250,
  /** A pause shorter than this does not end the speech. */
  minPauseMs: 500,
  /** Room kept around each stretch so a word's first and last sounds are not clipped. */
  padMs: 200,
  /** The longest window handed to Whisper, a little under its 30 second limit. */
  maxWindowMs: 28_000,
  /** Pauses longer than this between two stretches mean the window is cut there. */
  windowBreakMs: 2_000,
} as const;

/** A range of samples, end exclusive. */
export interface Region {
  start: number;
  end: number;
}

const msToSamples = (ms: number): number => Math.round((ms * VAD_SAMPLE_RATE) / 1000);

/** From one probability per frame to the stretches of speech, in samples. */
export function speechRegions(probs: ArrayLike<number>, totalSamples: number, s: typeof VAD_SETTINGS = VAD_SETTINGS): Region[] {
  const minPauseFrames = Math.ceil(s.minPauseMs / FRAME_MS);
  const regions: Region[] = [];
  let start = -1;
  let lastLoud = -1;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i] ?? 0;
    if (start < 0) {
      if (p >= s.startAbove) {
        start = i;
        lastLoud = i;
      }
    } else {
      if (p >= s.endBelow) lastLoud = i;
      else if (i - lastLoud >= minPauseFrames) {
        regions.push({ start: start * VAD_FRAME, end: (lastLoud + 1) * VAD_FRAME });
        start = -1;
      }
    }
  }
  if (start >= 0) regions.push({ start: start * VAD_FRAME, end: (lastLoud + 1) * VAD_FRAME });
  const pad = msToSamples(s.padMs);
  const minLen = msToSamples(s.minSpeechMs);
  const kept: Region[] = [];
  for (const r of regions) {
    if (r.end - r.start < minLen) continue;
    const padded = { start: Math.max(0, r.start - pad), end: Math.min(totalSamples, r.end + pad) };
    const prev = kept[kept.length - 1];
    if (prev && padded.start <= prev.end) prev.end = padded.end;
    else kept.push(padded);
  }
  return kept;
}

/**
 * Groups stretches of speech into windows Whisper can take. A window runs from its first stretch's start to its last stretch's end (the pauses
 * inside it stay), stays within `maxWindowMs`, and a pause longer than `windowBreakMs` always starts a new window. A single stretch longer
 * than the limit is cut into equal pieces.
 */
export function planWindows(regions: Region[], s: typeof VAD_SETTINGS = VAD_SETTINGS): Region[] {
  const max = msToSamples(s.maxWindowMs);
  const breakAt = msToSamples(s.windowBreakMs);
  const out: Region[] = [];
  let cur: Region | null = null;
  const flush = (): void => {
    if (!cur) return;
    const len = cur.end - cur.start;
    if (len <= max) out.push(cur);
    else {
      const parts = Math.ceil(len / max);
      const step = Math.ceil(len / parts);
      for (let at = cur.start; at < cur.end; at += step) out.push({ start: at, end: Math.min(cur.end, at + step) });
    }
    cur = null;
  };
  for (const r of regions) {
    if (cur && r.start - cur.end <= breakAt && r.end - cur.start <= max) cur.end = r.end;
    else {
      flush();
      cur = { start: r.start, end: r.end };
    }
  }
  flush();
  return out;
}

/** The fallback when the speech finder is not available: the whole clip in equal windows. */
export function fixedWindows(totalSamples: number, s: typeof VAD_SETTINGS = VAD_SETTINGS): Region[] {
  if (totalSamples <= 0) return [];
  return planWindows([{ start: 0, end: totalSamples }], s);
}

/** Milliseconds of speech inside the windows. */
export const windowsMs = (windows: Region[]): number => Math.round((windows.reduce((n, w) => n + (w.end - w.start), 0) * 1000) / VAD_SAMPLE_RATE);

// ---- the model ----------------------------------------------------------------------------------------------------------------------------

/** Runs the model over a whole clip and gives one probability per 32 ms frame. */
export interface VadRunner {
  probabilities(samples: Float32Array, onFraction?: (f: number) => void, isCancelled?: () => boolean): Promise<Float32Array>;
}

/** The slice of the model library the runner needs, so the file does not import it at load. */
export interface VadOutput {
  output: { data: ArrayLike<number> };
  stateN: unknown;
}
export interface VadLibrary {
  AutoModel: { from_pretrained(id: string, options: Record<string, unknown>): Promise<(inputs: Record<string, unknown>) => Promise<VadOutput>> };
  Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => unknown;
}

/** Loads Silero VAD from `/models/silero-vad/<revision>/onnx/model.onnx` (always on the processor: it is tiny). */
export async function createSileroRunner(lib: VadLibrary): Promise<VadRunner> {
  const model = await lib.AutoModel.from_pretrained(vadModelId(), { config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm' });
  const sr = new lib.Tensor('int64', [BigInt(VAD_SAMPLE_RATE)], []);
  return {
    async probabilities(samples, onFraction, isCancelled) {
      const frames = Math.ceil(samples.length / VAD_FRAME);
      const probs = new Float32Array(frames);
      let state: unknown = new lib.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
      const input = new Float32Array(VAD_CONTEXT + VAD_FRAME);
      for (let i = 0; i < frames; i++) {
        if (isCancelled?.()) break;
        // the last 64 samples of the step before (zeros at the start), then this step's 512 (zero-padded at the end)
        if (i > 0) input.copyWithin(0, VAD_FRAME, VAD_FRAME + VAD_CONTEXT);
        else input.fill(0, 0, VAD_CONTEXT);
        input.fill(0, VAD_CONTEXT);
        input.set(samples.subarray(i * VAD_FRAME, (i + 1) * VAD_FRAME), VAD_CONTEXT);
        const out = await model({ input: new lib.Tensor('float32', input.slice(), [1, input.length]), sr, state });
        probs[i] = out.output.data[0] ?? 0;
        state = out.stateN;
        if (onFraction && i % 64 === 0) onFraction(i / frames);
      }
      return probs;
    },
  };
}

// ---- the live form (PLAN P15-06) -------------------------------------------------------------------------------------------------------------
/*
 * Cutting a microphone that keeps running into chunks (PLAN P15-06, decision C14's client twin): a plain loudness check on every 20 ms, no model, so it costs next
 * to nothing on the page's main thread. A chunk is one stretch of speech: it closes after 600 ms of quiet, or at 28 seconds (a little under Whisper's 30 second
 * limit) at the latest, and after 20 seconds it already closes on a short breath so a long talker is cut between words, not through one. The model-based finder
 * above still runs inside the worker on every chunk, so this check only has to be roughly right: a missed breath makes a longer chunk, a click makes a chunk the
 * worker finds no speech in. Everything is plain arithmetic on samples, so it is unit-tested in Node.
 */

export const STREAM_SETTINGS = {
  /** A frame is 20 ms. */
  frameMs: 20,
  /** Quiet this long ends a chunk. */
  silenceMs: 600,
  /** Once a chunk is this long, a shorter quiet ends it. */
  softAfterMs: 20_000,
  softSilenceMs: 250,
  /** The longest chunk (Whisper takes 30 s; the worker keeps a margin). */
  maxChunkMs: 28_000,
  /** Speech shorter than this is a click or a cough and is thrown away. */
  minSpeechMs: 250,
  /** Room kept before the first loud frame and after the last one. */
  padMs: 200,
  /** Loud frames in a row that start a chunk (a single spike does not). */
  startFrames: 2,
} as const;

export type StreamSettings = { -readonly [K in keyof typeof STREAM_SETTINGS]: number };

/** One finished stretch of speech. Sample numbers count from the first sample ever pushed (16 kHz). */
export interface StreamChunk {
  /** Counts up for every chunk; a partial result and its final chunk share it. */
  id: number;
  samples: Float32Array;
  startSample: number;
  endSample: number;
}

/** Says whether one 20 ms frame is speech. */
export type FrameClassifier = (frame: Float32Array) => boolean;

/** Root-mean-square loudness of a frame. */
export function frameLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * Loudness against a floor that follows the room's noise: it drops to a quiet frame at once and creeps up slowly, so a fan is learned in a second or two and a
 * person who starts talking is not. A frame is speech when it is a few times the floor and above an absolute minimum.
 */
export function createEnergyClassifier(opts: { minLevel?: number; ratio?: number } = {}): FrameClassifier {
  const minLevel = opts.minLevel ?? 0.012;
  const ratio = opts.ratio ?? 3;
  let floor = 0.004;
  return (frame) => {
    const level = frameLevel(frame);
    floor = level < floor ? level : floor + (level - floor) * 0.002;
    return level >= Math.max(minLevel, floor * ratio);
  };
}

export interface StreamingSegmenter {
  /** Feeds more 16 kHz samples (any length). Finished chunks come out through `onChunk` before this returns. */
  push(samples: Float32Array): void;
  /** Ends the open chunk now (the microphone was muted, or the engine stops). A short click is dropped as usual. */
  flush(): void;
  /** The speech heard so far in the open chunk, newest `maxSamples` of it, or null when nobody is talking. Used for the partial lines. */
  current(maxSamples?: number): StreamChunk | null;
  /** How many samples have been pushed. */
  readonly position: number;
}

export interface StreamingSegmenterOptions {
  onChunk(chunk: StreamChunk): void;
  isSpeech?: FrameClassifier;
  settings?: Partial<StreamSettings>;
}

const concat = (parts: Float32Array[], total: number): Float32Array => {
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function createStreamingSegmenter(options: StreamingSegmenterOptions): StreamingSegmenter {
  const s: StreamSettings = { ...STREAM_SETTINGS, ...options.settings };
  const isSpeech = options.isSpeech ?? createEnergyClassifier();
  const frameLen = Math.round((VAD_SAMPLE_RATE * s.frameMs) / 1000);
  const padFrames = Math.ceil(s.padMs / s.frameMs);
  const startFrames = Math.max(1, s.startFrames);

  let position = 0; // samples pushed
  let carry: Float32Array = new Float32Array(0); // less than a frame, waiting for more
  let nextId = 1;
  // before a chunk: the last few frames, kept as the pre-roll, and the loud run so far
  let pre: Float32Array[] = [];
  let loudRun = 0;
  // in a chunk
  let open = false;
  let id = 0;
  let frames: Float32Array[] = [];
  let startSample = 0;
  let sampleCount = 0;
  let speechFrames = 0;
  let quietRun = 0; // frames of quiet since the last loud one

  const begin = (atFrame: Float32Array[], firstSample: number): void => {
    open = true;
    id = nextId++;
    frames = atFrame;
    startSample = firstSample;
    sampleCount = atFrame.reduce((n, f) => n + f.length, 0);
    speechFrames = 0;
    quietRun = 0;
  };

  const close = (): void => {
    if (!open) return;
    // keep the pad of the quiet that followed the last loud frame, drop the rest
    const dropFrames = Math.max(0, quietRun - padFrames);
    const kept = dropFrames > 0 ? frames.slice(0, frames.length - dropFrames) : frames;
    const total = kept.reduce((n, f) => n + f.length, 0);
    const chunk: StreamChunk = { id, samples: concat(kept, total), startSample, endSample: startSample + total };
    const long = speechFrames * s.frameMs >= s.minSpeechMs;
    open = false;
    frames = [];
    sampleCount = 0;
    speechFrames = 0;
    quietRun = 0;
    pre = [];
    loudRun = 0;
    if (long) options.onChunk(chunk);
  };

  const frame = (f: Float32Array, firstSample: number): void => {
    const speech = isSpeech(f);
    // the caller's buffer may be reused by the audio system, so what is kept is a copy
    const own = f.slice();
    if (!open) {
      pre.push(own);
      if (pre.length > padFrames + startFrames) pre.shift();
      loudRun = speech ? loudRun + 1 : 0;
      if (loudRun >= startFrames) {
        const taken = pre;
        pre = [];
        const first = firstSample + f.length - taken.reduce((n, x) => n + x.length, 0);
        begin(taken, first);
        speechFrames = loudRun;
        loudRun = 0;
      }
      return;
    }
    frames.push(own);
    sampleCount += f.length;
    if (speech) {
      speechFrames += 1;
      quietRun = 0;
    } else {
      quietRun += 1;
    }
    const lengthMs = (sampleCount * 1000) / VAD_SAMPLE_RATE;
    const silenceNeeded = lengthMs >= s.softAfterMs ? s.softSilenceMs : s.silenceMs;
    if (quietRun * s.frameMs >= silenceNeeded) close();
    else if (lengthMs >= s.maxChunkMs) {
      // too long: cut here and go straight on with a new chunk, since the person is still talking
      const wasQuiet = quietRun;
      close();
      if (wasQuiet === 0) begin([], firstSample + f.length);
    }
  };

  return {
    push(samples) {
      let data = samples;
      if (carry.length > 0) {
        data = new Float32Array(carry.length + samples.length);
        data.set(carry, 0);
        data.set(samples, carry.length);
      }
      let at = 0;
      const base = position - carry.length;
      while (at + frameLen <= data.length) {
        frame(data.subarray(at, at + frameLen), base + at);
        at += frameLen;
      }
      carry = data.slice(at);
      position += samples.length;
    },
    flush() {
      close();
      carry = new Float32Array(0);
    },
    current(maxSamples) {
      if (!open || speechFrames * s.frameMs < s.minSpeechMs) return null;
      const total = sampleCount;
      let all = concat(frames, total);
      let from = startSample;
      if (maxSamples !== undefined && all.length > maxSamples) {
        all = all.subarray(all.length - maxSamples);
        from = startSample + total - all.length;
      }
      return { id, samples: all, startSample: from, endSample: startSample + total };
    },
    get position() {
      return position;
    },
  };
}
