import type { LlmTranscribeRequest, LlmTranscribeResult, PluginContext, PluginTx } from '@manythreads/sdk';

// The `transcribe` door of the `llm` provider (PLAN P15-07, P15-19, decision C15): one WAV in, its text out, through the pre-call check, the master key and a spend line
// (purpose `transcribe`). The request and result types are in the SDK (`@manythreads/sdk`, `LlmTranscriber`), because the meetings plugin calls this door and plugins do not
// import each other. The body belongs to work package S3; until then the door answers that no transcriber is set up.
export async function transcribe(ctx: PluginContext, tx: PluginTx, request: LlmTranscribeRequest): Promise<LlmTranscribeResult> {
  void [ctx, tx, request];
  return { outcome: 'unavailable', reason: 'Server transcription is not set up yet.' };
}
