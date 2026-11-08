// Voice activity detection for the server-side listener (PLAN P15-19, decision C14): a pure energy detector that cuts a stream of 16 kHz mono samples into chunks
// at silences of 600 ms or more, never longer than 30 s, so each chunk can be sent to the transcriber as one WAV. No Node imports and only erasable TypeScript
// (no enums, no parameter properties): the listener's worker thread loads this file with Node's own type stripping.
//
// How it works. The stream is read in frames of 20 ms. A frame is "speech" when the RMS (root mean square: the average loudness) of its 16-bit samples reaches
// `threshold`. A chunk opens at the first speech frame (with up to 240 ms of the silence before it, so a soft first syllable is kept) and closes after
// `silenceMs` of frames below the threshold (the silence after the speech is cut back to 240 ms) or when it reaches `maxChunkMs`. A chunk with less than
// `minSpeechMs` of speech in it is a click or a breath and is dropped. Nothing else is dropped: all other audio reaches the transcriber.

export const VAD_SILENCE_MS = 600;
export const VAD_CHUNK_MAX_MS = 30_000;
/** Chunks shorter than this are dropped as noise (milliseconds of speech). */
export const VAD_MIN_SPEECH_MS = 250;
/** The RMS of a 16-bit frame below which it counts as silence. Quiet speech sits around 300 to 800; a still room around 5 to 60. */
export const VAD_THRESHOLD = 350;

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
/** Silence kept at each end of a chunk. */
const PAD_MS = 240;
const PAD_FRAMES = PAD_MS / FRAME_MS;

export interface VadChunk {
  /** 16 kHz mono 16-bit samples of the chunk, silence at its ends trimmed to at most 240 ms. */
  samples: Int16Array;
  /** When the chunk starts, in milliseconds on the stream's clock (the caller says where the stream's zero is). */
  startMs: number;
  durationMs: number;
}

export interface VadOptions {
  silenceMs?: number;
  maxChunkMs?: number;
  minSpeechMs?: number;
  /** Energy (RMS of the 16-bit samples) below which a frame counts as silence. */
  threshold?: number;
}

export interface VadSegmenter {
  /** Feed the next samples of the stream; returns the chunks that were completed by them (often none). */
  push(samples: Int16Array): VadChunk[];
  /** The stream ended: whatever speech is left becomes a last chunk. */
  flush(): VadChunk[];
  /** Forget everything buffered without producing a chunk (the speaker withdrew consent: nothing of what was heard may leave). */
  discard(): void;
  /** How many milliseconds of the stream have been fed in so far (the stream's clock, from `streamStartMs`). */
  positionMs(): number;
}

/** The RMS of one frame. */
function rms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

/** Cuts a stream of 16 kHz mono samples into speech chunks. `streamStartMs` is where the stream's zero sits on the caller's clock. */
export function createVadSegmenter(options: VadOptions = {}, streamStartMs = 0): VadSegmenter {
  const silenceFrames = Math.max(1, Math.round((options.silenceMs ?? VAD_SILENCE_MS) / FRAME_MS));
  const maxFrames = Math.max(2, Math.floor((options.maxChunkMs ?? VAD_CHUNK_MAX_MS) / FRAME_MS));
  const minSpeechFrames = Math.max(1, Math.round((options.minSpeechMs ?? VAD_MIN_SPEECH_MS) / FRAME_MS));
  const threshold = options.threshold ?? VAD_THRESHOLD;

  // the partial frame left over from the last push
  let carry = new Int16Array(FRAME_SAMPLES);
  let carried = 0;
  // frames seen so far (the stream position)
  let frameIndex = 0;
  // the quiet frames before the chunk (at most PAD_FRAMES), oldest first
  let lead: Int16Array[] = [];
  // the open chunk
  let open = false;
  let frames: Int16Array[] = [];
  let startFrame = 0;
  let speechFrames = 0;
  let quietRun = 0;

  const reset = (): void => {
    open = false;
    frames = [];
    speechFrames = 0;
    quietRun = 0;
  };

  /** Close the open chunk: trim the trailing quiet frames to PAD_FRAMES and return it, or null when it held too little speech. */
  const close = (): VadChunk | null => {
    const speech = speechFrames;
    const start = startFrame;
    const kept = frames;
    const trailing = quietRun;
    reset();
    if (speech < minSpeechFrames) return null;
    const keep = trailing > PAD_FRAMES ? kept.length - (trailing - PAD_FRAMES) : kept.length;
    const used = kept.slice(0, keep);
    const samples = new Int16Array(used.length * FRAME_SAMPLES);
    for (let i = 0; i < used.length; i++) samples.set(used[i]!, i * FRAME_SAMPLES);
    return { samples, startMs: streamStartMs + start * FRAME_MS, durationMs: used.length * FRAME_MS };
  };

  const onFrame = (frame: Int16Array, out: VadChunk[]): void => {
    const loud = rms(frame) >= threshold;
    if (!open) {
      if (!loud) {
        lead.push(frame);
        if (lead.length > PAD_FRAMES) lead.shift();
        frameIndex += 1;
        return;
      }
      open = true;
      frames = [...lead, frame];
      startFrame = frameIndex - lead.length;
      lead = [];
      speechFrames = 1;
      quietRun = 0;
      frameIndex += 1;
      return;
    }
    frames.push(frame);
    frameIndex += 1;
    if (loud) {
      speechFrames += 1;
      quietRun = 0;
    } else {
      quietRun += 1;
    }
    if (quietRun >= silenceFrames || frames.length >= maxFrames) {
      const done = close();
      if (done) out.push(done);
    }
  };

  return {
    push(samples) {
      const out: VadChunk[] = [];
      let at = 0;
      while (at < samples.length) {
        const take = Math.min(FRAME_SAMPLES - carried, samples.length - at);
        carry.set(samples.subarray(at, at + take), carried);
        carried += take;
        at += take;
        if (carried === FRAME_SAMPLES) {
          onFrame(carry, out);
          carry = new Int16Array(FRAME_SAMPLES);
          carried = 0;
        }
      }
      return out;
    },
    flush() {
      const out: VadChunk[] = [];
      if (open) {
        const done = close();
        if (done) out.push(done);
      }
      lead = [];
      carried = 0;
      return out;
    },
    discard() {
      reset();
      lead = [];
      carried = 0;
    },
    positionMs: () => streamStartMs + frameIndex * FRAME_MS + Math.round((carried / SAMPLE_RATE) * 1000),
  };
}
