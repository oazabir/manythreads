/*
 * The one door to speech-to-text: `getSpeechEngine()` says what this device can do and hands back an engine with `transcribe(blob)`.
 *   fake     the test build (VITE_MANYTHREADS_FAKE_ASR=1): a known sentence for every clip.
 *   whisper  a real model in a worker, once a backend is registered and the device check passes.
 *   none     it cannot be done here; `reason` is one plain sentence for the person.
 * The Whisper worker lives in its own task and plugs in with `registerWhisperBackend`.
 */
import { decodeToSpeechAudio, type DecodeContextFactory } from './decode';
import { chooseModel, hasSpeechPlatform, readDeviceFacts, type DeviceFacts } from './device';
import { createFakeEngine, fakeAsrEnabled } from './fake';
import { SpeechError, type SpeechEngine, type TranscribeOptions, type Transcript, type WhisperBackend, type WhisperModelName } from './types';

export const NO_PLATFORM_REASON = "This browser can't write out voice messages.";
export const NO_BACKEND_REASON = "Writing out voice messages isn't ready in this browser yet.";

let backend: WhisperBackend | null = null;
let cached: Promise<SpeechEngine> | null = null;

/** Plugs the Whisper worker in (or removes it with null). Forgets any engine chosen earlier. */
export function registerWhisperBackend(b: WhisperBackend | null): void {
  backend = b;
  cached = null;
}

/** Forgets the chosen engine so the next call checks the device again. */
export function resetSpeechEngine(): void {
  cached = null;
}

export function noneEngine(reason: string): SpeechEngine {
  return {
    kind: 'none',
    model: null,
    reason,
    transcribe: () => Promise.reject(new SpeechError('unavailable', reason)),
  };
}

function whisperEngine(model: WhisperModelName, b: WhisperBackend, makeContext?: DecodeContextFactory): SpeechEngine {
  return {
    kind: 'whisper',
    model,
    async transcribe(audio: Blob, options: TranscribeOptions = {}): Promise<Transcript> {
      if (options.signal?.aborted) throw new SpeechError('aborted', 'Writing it out was cancelled.');
      const pcm = await decodeToSpeechAudio(audio, makeContext);
      if (options.signal?.aborted) throw new SpeechError('aborted', 'Writing it out was cancelled.');
      return b.transcribe(model, pcm, options);
    },
  };
}

export interface EngineInputs {
  /** Replaces the device facts read from the browser (tests). */
  facts?: DeviceFacts;
  /** Whether a worker and audio decoding exist; defaults to looking at the browser. */
  platform?: boolean;
  makeContext?: DecodeContextFactory;
}

/** Picks the engine without caching. */
export async function chooseSpeechEngine(inputs: EngineInputs = {}): Promise<SpeechEngine> {
  if (fakeAsrEnabled()) return createFakeEngine(inputs.makeContext);
  if (!(inputs.platform ?? hasSpeechPlatform())) return noneEngine(NO_PLATFORM_REASON);
  const choice = chooseModel(inputs.facts ?? (await readDeviceFacts()));
  if (choice.model === null) return noneEngine(choice.reason);
  if (!backend) return noneEngine(NO_BACKEND_REASON);
  return whisperEngine(choice.model, backend, inputs.makeContext);
}

/** The engine for this device, checked once per page load. */
export function getSpeechEngine(): Promise<SpeechEngine> {
  cached ??= chooseSpeechEngine();
  return cached;
}
