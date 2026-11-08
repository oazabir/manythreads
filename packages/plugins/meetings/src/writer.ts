import type { PluginContext } from '@manythreads/sdk';

// Work package S1 (P15-09, decision C4, C5, C6): writing the transcript file two minutes ten seconds after a room ended (the repo for a public channel, Files storage for a
// private channel or a direct message), and writing it again, debounced, after a correction. Emits `meetings.transcript.written`. STUB: nothing is registered until S1.
export function registerTranscriptWriter(ctx: PluginContext): void {
  void ctx;
  // S1: ctx.jobs.register('meetings.transcript', ...) and the debounced re-write job.
}
