import type { MeetingRunsProvider } from '@manythreads/sdk';

// Work package S2 (P15-10, P15-24): the `meeting.runs` provider. `notes` runs the Scribe (or a room's note-taker) over one transcript, synchronously, as the Archivist's distil
// step does; `answer` runs the note-taker for a question, confined to the channels every present person may read. Both ends are in the SDK (`MeetingRunsProvider`); the
// meetings plugin looks the provider up when it needs it. STUB: both answer `failed` until S2.
export function createMeetingRunsProvider(): MeetingRunsProvider {
  return {
    id: 'meeting.runs',
    async notes() {
      return { outcome: 'failed', message: 'Notes are not built yet.' };
    },
    async answer() {
      return { outcome: 'failed', message: 'Answers are not built yet.' };
    },
  };
}
