// Voice activity detection for the server-side listener (PLAN P15-19, decision C14): a pure energy detector that cuts a stream of 16 kHz mono samples into chunks
// at silences of 600 ms or more, never longer than 30 s, so each chunk can be sent to the transcriber as one WAV. No Node imports: the listener's worker thread
// runs it. The body belongs to work package S4; this file fixes the shape.

export const VAD_SILENCE_MS = 600;
export const VAD_CHUNK_MAX_MS = 30_000;
/** Chunks shorter than this are dropped as noise (milliseconds of speech). */
export const VAD_MIN_SPEECH_MS = 250;

export interface VadChunk {
  /** 16 kHz mono 16-bit samples of the chunk, silence at its ends trimmed to at most a quarter second. */
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
}

/** Work package S4 fills this in. */
export function createVadSegmenter(options: VadOptions = {}, streamStartMs = 0): VadSegmenter {
  void [options, streamStartMs];
  throw new Error('Not built yet: createVadSegmenter belongs to the listener work package');
}
