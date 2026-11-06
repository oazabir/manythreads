/*
 * The shapes of the on-device speech engine (PLAN P14-16): one call, `transcribe(blob)`, that turns a recorded clip into words with times.
 * Nothing here knows how the words are found: the fake engine (tests), the Whisper worker (a later task registers it) and the "none" engine all fit it.
 */

/** One stretch of speech: the words and where they sit in the clip, in milliseconds from its start. */
export interface SpeechSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface Transcript {
  segments: SpeechSegment[];
  /** All the segments joined with single spaces. */
  text: string;
  /** Two-letter language code the engine settled on ("en"), or null when it could not tell. */
  language: string | null;
}

/** What an engine reports while it works, so the screen can say "Getting the speech model ready… 34%". */
export interface SpeechProgress {
  stage: 'model' | 'listening';
  /** 0 to 1. */
  fraction: number;
}

export interface TranscribeOptions {
  /** Force a language ("bn") instead of letting the engine detect it. */
  language?: string;
  signal?: AbortSignal;
  onProgress?: (p: SpeechProgress) => void;
}

/** The size of Whisper model the device can carry. */
export type WhisperModelName = 'tiny' | 'base';

export type SpeechEngineKind = 'fake' | 'whisper' | 'none';

export interface SpeechEngine {
  kind: SpeechEngineKind;
  /** The model in use; 'fake' for the test engine, null when there is none. */
  model: WhisperModelName | 'fake' | null;
  /** Set when kind is 'none': one plain sentence saying why. */
  reason?: string;
  /** Rejects with a SpeechError (`unavailable` for the none engine, `aborted` when the signal fires). */
  transcribe(audio: Blob, options?: TranscribeOptions): Promise<Transcript>;
}

/** Mono audio at 16,000 samples a second, the form every speech model takes. */
export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * What the Whisper worker (a later task) offers the engine: it gets samples already at 16 kHz mono and returns the words.
 * It is registered with `registerWhisperBackend`, so this core never imports the model library.
 */
export interface WhisperBackend {
  transcribe(model: WhisperModelName, audio: PcmAudio, options: TranscribeOptions): Promise<Transcript>;
}

export type SpeechErrorCode = 'unavailable' | 'aborted' | 'decode';

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  constructor(code: SpeechErrorCode, message: string) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
  }
}
