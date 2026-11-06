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
