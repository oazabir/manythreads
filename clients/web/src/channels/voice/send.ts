import { VOICE_MAX_MS, voiceFallbackBody, type VoiceMeta } from '@manythreads/shared';
import { VOICE_MIN_MS } from './clock';

/**
 * Builds what a voice message posts (P14-17): the body and the `voice` meta that goes with the uploaded clip.
 *
 * SEAM for the transcript (F9-7): the preview will pass the words the device wrote (and the language) as `transcript`; until then every
 * message is sent without one, so the body is the stand-in line ("Voice message (0:42)") and the meta says `transcript: 'none'`.
 */

export type VoiceTranscript = { text: string; language: string | null };

export type VoiceSendInput = {
  fileId: VoiceMeta['fileId'];
  durationMs: number;
  peaks: readonly number[];
  transcript?: VoiceTranscript | null;
};

const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export function buildVoiceSend(input: VoiceSendInput): { body: string; voice: VoiceMeta } {
  const durationMs = Math.min(VOICE_MAX_MS, Math.max(VOICE_MIN_MS, Math.round(input.durationMs)));
  const text = input.transcript?.text.trim() ?? '';
  const language = input.transcript?.language ?? null;
  const voice: VoiceMeta = {
    fileId: input.fileId,
    durationMs,
    language: text !== '' && language !== null && LANGUAGE.test(language) ? language : null,
    transcript: text !== '' ? 'device' : 'none',
    peaks: input.peaks.slice(0, 64).map((p) => Math.min(255, Math.max(0, Math.round(p)))),
  };
  return { body: text !== '' ? text : voiceFallbackBody(durationMs), voice };
}
