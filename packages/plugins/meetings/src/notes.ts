import type { PluginContext } from '@manythreads/sdk';
import { MEETINGS_NOTES_WRITE_CAPABILITY, MEETINGS_READ_CAPABILITY } from '@manythreads/shared';

// Work package S2 (P15-10, P15-12): after a room's transcript is written, the Scribe (or the room's note-taker) reads it (`meetings.read`), answers the notes as JSON, and
// the platform writes `notes.md` itself (`meetings.write_notes`), posts the summary into the call thread and emits `meetings.notes.written`. STUBS: the two capabilities
// answer that they are not built until S2.
export function registerNotes(ctx: PluginContext): void {
  const notBuiltAnswer = async (): Promise<Record<string, unknown>> => ({ ok: false, code: 'not_built', message: 'Not built yet' });
  ctx.capabilities.register(MEETINGS_READ_CAPABILITY, notBuiltAnswer);
  ctx.capabilities.register(MEETINGS_NOTES_WRITE_CAPABILITY, notBuiltAnswer);
}
