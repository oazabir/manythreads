/*
 * The place where the on-device speech engine plugs in (PLAN P15-06 builds it: clients/web/src/speech, a streaming form that runs on the person's own microphone
 * only). Until it exists nothing here writes any words, so the page must not offer to turn transcription on: it would show "Transcribing" while nothing is. A
 * browser test may switch the offer on with `VITE_MANYTHREADS_FAKE_ASR=1` (an engine that listens to nothing and writes nothing).
 */

export interface TranscribeEngine {
  /** Starts listening to the person's own microphone and sending lines. */
  start(): void;
  stop(): void;
}

export const engineAvailable = (): boolean => import.meta.env.VITE_MANYTHREADS_FAKE_ASR === '1';

/** The engine for the person's device, or null when there is none. */
export async function loadEngine(): Promise<TranscribeEngine | null> {
  if (!engineAvailable()) return null;
  return { start: () => undefined, stop: () => undefined };
}
