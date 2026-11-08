import type { PluginContext } from '@manythreads/sdk';

// Work package S4 (P15-19): the note-taker's listener. It joins the room through `MediaProvider.listen`, hears only the people who said yes, cuts their speech at pauses
// (`audio/vad.ts`), sends each chunk to `LlmTranscriber.transcribe`, stores the text as a server line and appends the Personal transcript every thirty seconds.
// At most `MANYTHREADS_NOTETAKER_MAX_ROOMS` rooms per server process. STUB: nothing is registered until S4.
export function registerListener(ctx: PluginContext): void {
  void ctx;
  // S4: the listeners by room, the subscription refresh on consent, join, leave and kick.
}
