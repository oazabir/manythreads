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
