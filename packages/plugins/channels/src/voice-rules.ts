import type { PluginTx } from '@manythreads/sdk';
import { VOICE_TRANSCRIPT_MAX_MS, type VoiceMeta, voiceFallbackBody } from '@manythreads/shared';

// The posting rules of a voice message (P32-02, decision D13), kept apart from the job (`voice.ts`) so the post path can use them without importing the job.

export const VOICE_QUEUE = 'channels.voice-transcribe';
/** Attempts before the job gives up (the last one writes `failed`). */
export const VOICE_MAX_ATTEMPTS = 3;

/** The workspace's switch (Settings, Workspace): on unless an admin set it to the literal `false`. Readable by any member. */
export async function voiceTranscriptsOn(tx: PluginTx): Promise<boolean> {
  const row = (await tx.query<{ vt: string | null }>("SELECT settings ->> 'voiceTranscripts' AS vt FROM app.workspaces WHERE id = app.workspace_id()")).rows[0];
  return row?.vt !== 'false';
}

export interface DecidedVoice {
  voice: VoiceMeta;
  body: string;
  /** The server will write the transcript: queue the job. */
  queue: boolean;
}

/**
 * What the server stores for a voice message a person sent, whatever the client claimed. Only the clip's name, length, language hint and loudness bars are
 * taken from the client. `transcript`, `transcriptEndMs`, `transcriptNote` and `transcriptRetry` are the server's own: `pending` when the switch is on, `none` when it
 * is off, and the body is the stand-in line either way. One exception keeps an old (cached) web bundle working: a send that says `device` and carries words is
 * the person's own text from their device; it is kept as it came, marked `device`, whatever the switch says.
 */
export function decideVoice(sent: VoiceMeta, body: string, switchOn: boolean): DecidedVoice {
  const stand = voiceFallbackBody(sent.durationMs);
  if (sent.transcript === 'device' && body.trim() !== '' && body !== stand) {
    return { voice: { fileId: sent.fileId, durationMs: sent.durationMs, language: sent.language, transcript: 'device', peaks: sent.peaks }, body, queue: false };
  }
  return {
    voice: { fileId: sent.fileId, durationMs: sent.durationMs, language: null, transcript: switchOn ? 'pending' : 'none', peaks: sent.peaks },
    body: stand,
    queue: switchOn,
  };
}

/** The first `VOICE_TRANSCRIPT_MAX_MS` of the clip are transcribed, never more than the clip. */
export const transcribedRangeMs = (durationMs: number): number => Math.min(durationMs, VOICE_TRANSCRIPT_MAX_MS);

/** The body a transcript becomes: the words, with " …" added when the clip is longer than what was transcribed. */
export const transcriptBody = (text: string, durationMs: number): string => `${text.trim()}${durationMs > transcribedRangeMs(durationMs) ? ' …' : ''}`;

