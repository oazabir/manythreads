import type { PluginTx, ProviderImpl } from './types.ts';

// Speech to text on the server (PLAN P15-07, P15-19, decision C15). The `llm` provider (gateway-llm) gains one door, `transcribe`, with the same promises as its other
// doors: the pre-call check (budgets, egress preset), the master key and a spend line (purpose `transcribe`) are inside, and it never throws for an unavailable model.
// The meetings plugin is the caller (the audio-chunk route and the note-taker's listener); it looks the provider up when it needs it:
//
//   ctx.providers.get<LlmTranscriber>('llm')
//
// Audio is never stored by the door: the bytes are sent on and dropped.

export interface LlmTranscribeRequest {
  workspaceId: string;
  teamId: string | null;
  /** The meeting the audio belongs to (a session label on the spend line). */
  meetingId: string;
  /** Whose voice it is. */
  actorId: string;
  /** One 16 kHz mono 16-bit WAV, at most 2 MiB and 30 s. */
  wav: Uint8Array;
  durationMs: number;
  /** A language hint (`en`, `ar`); the model detects when absent. */
  lang?: string;
}

export type LlmTranscribeResult =
  | { outcome: 'text'; text: string; lang: string | null }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'refused'; reason: string };

export interface LlmTranscriber extends ProviderImpl {
  transcribe(tx: PluginTx, request: LlmTranscribeRequest): Promise<LlmTranscribeResult>;
}

// ---- The clip door (P32-03, decision D13) --------------------------------------------------------------------------------------------------------------
// A voice message is transcribed on the server from the clip as the browser recorded it (WebM, Ogg or MP4, not a WAV): `transcribeClip` sends it to the speech
// model behind the `transcribe` alias. The channels plugin's job is the caller. Beside the promises of `transcribe` above it adds three:
//   * the model must be inside this deployment (the alias's provider is marked local); a model elsewhere is refused and nothing is sent;
//   * no database transaction is held while the model works: the door opens two short ones through `inTx` (the check before, the spend line after);
//   * the audio is never stored, and the door never throws for an unavailable model.

/** The largest clip the door sends: 8 MiB (a five-minute recording is well under it). */
export const VOICE_CLIP_MAX_BYTES = 8 * 1024 * 1024;

/** Runs `fn` in one short transaction as the system actor, scoped to the workspace (a detached job's `job.transaction`). */
export type ClipInTx = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

export interface LlmClipRequest {
  workspaceId: string;
  teamId: string | null;
  /** The message the clip belongs to (a session label on the spend line). */
  messageId: string;
  /** Whose voice it is. */
  actorId: string;
  /** The clip's bytes as stored, at most `VOICE_CLIP_MAX_BYTES`. */
  clip: Uint8Array;
  /** The clip's own content type (`audio/webm`, `audio/mp4`, ...), sent on unchanged. */
  contentType: string;
  durationMs: number;
}

/**
 * `text`: the words (the model reads the first 20 seconds only; the caller knows the clip's length). `unavailable`: the model was busy, too slow or did not
 * answer; trying again later may work. `refused`: it will not work as it stands (the model is not set up, is not inside this deployment, the workspace's limits
 * or guardrails said no, the clip is empty or too large, or the model rejected it); trying again does not help until something is changed.
 */
export type LlmClipResult =
  | { outcome: 'text'; text: string; lang: string | null }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'refused'; reason: string };

export interface LlmClipTranscriber extends ProviderImpl {
  transcribeClip(request: LlmClipRequest, inTx: ClipInTx): Promise<LlmClipResult>;
  /** Whether a clip would be sent now: the `transcribe` model is set up and inside this deployment (or the test stand-in is on). Reads only. */
  clipStatus(tx: PluginTx, workspaceId: string): Promise<{ ready: true } | { ready: false; reason: string }>;
}
