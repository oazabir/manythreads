import { VOICE_MAX_MS, voiceFallbackBody, type VoiceMeta } from '@manythreads/shared';
import { VOICE_MIN_MS } from './clock';

/**
 * Builds what a voice message posts (P14-17, P32-05): the body and the `voice` meta that go with the uploaded clip.
 *
 * The sender never writes the words: the server does (decision D13), and it decides the transcript state itself. So the body is the stand-in line
 * ("Voice message (0:42)"), which the server replaces with the transcript, and the meta says `transcript: 'none'`, a value the server overrides.
 */

export type VoiceSendInput = {
  fileId: VoiceMeta['fileId'];
  durationMs: number;
  peaks: readonly number[];
};

export function buildVoiceSend(input: VoiceSendInput): { body: string; voice: VoiceMeta } {
  const durationMs = Math.min(VOICE_MAX_MS, Math.max(VOICE_MIN_MS, Math.round(input.durationMs)));
  const voice: VoiceMeta = {
    fileId: input.fileId,
    durationMs,
    language: null,
    transcript: 'none',
    peaks: input.peaks.slice(0, 64).map((p) => Math.min(255, Math.max(0, Math.round(p)))),
  };
  return { body: voiceFallbackBody(durationMs), voice };
}
