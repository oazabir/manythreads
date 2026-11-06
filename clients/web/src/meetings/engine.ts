/*
 * The place where the on-device speech engine plugs in (PLAN P15-06 builds the live, streaming form on top of clients/web/src/speech, which today turns a finished
 * clip into words, P14-16). Until the live form exists nothing here writes any words, so the page must not offer to turn transcription on: it would show
 * "Transcribing" while nothing is. A browser test may switch the offer on with `VITE_MANYTHREADS_FAKE_ASR=1` (an engine that listens to nothing and writes
 * nothing); the speech module owns that switch and this file reads it from there.
 */
import { fakeAsrEnabled } from '../speech/fake';

export interface TranscribeEngine {
  /** Starts listening to the person's own microphone and sending lines. */
  start(): void;
  stop(): void;
}

export const engineAvailable = (): boolean => fakeAsrEnabled();

/** The engine for the person's device, or null when there is none. */
export async function loadEngine(): Promise<TranscribeEngine | null> {
  if (!engineAvailable()) return null;
  return { start: () => undefined, stop: () => undefined };
}
