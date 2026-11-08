import type { PluginContext } from '@manythreads/sdk';
import type { MeetingCaption } from '@manythreads/shared';

// Work package S1 (P15-08, decision C2): live captions. The room's captions are coalesced in process memory and pushed to the people present as `MEETING_CAPTION_PUSH`, at most four
// pushes a second per room. `pushCaption` is what the note-taker's listener (S4) and the questions (S5) call, so the coalescer is one for the room.
// STUB: the function is declared and throws until S1.
export function registerCaptions(ctx: PluginContext): void {
  void ctx;
  // S1: the per-room coalescer and its flush timer.
}

export async function pushCaption(ctx: PluginContext, meetingId: string, caption: MeetingCaption): Promise<void> {
  void [ctx, meetingId, caption];
  throw new Error('Not built yet: pushCaption belongs to the transcript work package');
}
