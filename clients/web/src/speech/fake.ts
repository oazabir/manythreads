/*
 * The test engine. `VITE_MANYTHREADS_FAKE_ASR=1` (a build-time switch the browser-test build sets and production never does) makes every clip
 * "say" the same known sentence, so the browser tests can check the whole flow without a model.
 */
import { clipDurationMs, type DecodeContextFactory } from './decode';
import { SpeechError, type SpeechEngine, type SpeechSegment, type TranscribeOptions, type Transcript } from './types';

export const FAKE_TEXT = 'This is a test voice message.';
export const FAKE_LANGUAGE = 'en';
/** Used when the clip cannot be decoded here (a test with no audio support). */
const FALLBACK_DURATION_MS = 3000;
const WORDS_PER_SEGMENT = 3;

export const fakeAsrEnabled = (): boolean => import.meta.env.VITE_MANYTHREADS_FAKE_ASR === '1';

/** The known text cut into runs of three words, each given a share of the clip's length in proportion to its letters. */
export function fakeTranscript(durationMs: number, text: string = FAKE_TEXT): Transcript {
  const words = text.split(' ').filter(Boolean);
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_SEGMENT) groups.push(words.slice(i, i + WORDS_PER_SEGMENT).join(' '));
  const total = groups.reduce((n, g) => n + g.length, 0) || 1;
  const segments: SpeechSegment[] = [];
  let used = 0;
  let at = 0;
  for (const g of groups) {
    used += g.length;
    const end = used === total ? durationMs : Math.round((durationMs * used) / total);
    segments.push({ text: g, startMs: at, endMs: end });
    at = end;
  }
  return { segments, text: groups.join(' '), language: FAKE_LANGUAGE };
}

export function createFakeEngine(makeContext?: DecodeContextFactory): SpeechEngine {
  return {
    kind: 'fake',
    model: 'fake',
    async transcribe(audio: Blob, options: TranscribeOptions = {}): Promise<Transcript> {
      const abort = (): never => {
        throw new SpeechError('aborted', 'Writing it out was cancelled.');
      };
      if (options.signal?.aborted) abort();
      options.onProgress?.({ stage: 'listening', fraction: 0 });
      let ms = FALLBACK_DURATION_MS;
      try {
        ms = await clipDurationMs(audio, makeContext);
      } catch {
        // The fake still answers when the clip cannot be decoded here.
      }
      if (options.signal?.aborted) abort();
      options.onProgress?.({ stage: 'listening', fraction: 1 });
      const t = fakeTranscript(Math.max(1, ms));
      return options.language ? { ...t, language: options.language } : t;
    },
  };
}
