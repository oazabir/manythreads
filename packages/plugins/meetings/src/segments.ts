import type { PluginContext } from '@manythreads/sdk';

// Work package S1 (P15-08, P15-14): taking lines into the transcript: the strip of control and bidirectional characters, the dedupe between two devices, partial lines
// that only become captions, and a voice message in the call thread becoming a `device` line for its author. STUB: nothing is registered until S1.
export function registerSegments(ctx: PluginContext): void {
  void ctx;
  // S1: ctx.events.subscribe('channel.message.posted', ...) for a voice message in a live or late-window room's thread.
}
