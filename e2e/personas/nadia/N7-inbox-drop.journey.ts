// N7 · Drop the Q3 planning PDF and a pasted action list into the Engineering inbox, watch the Archivist file them, ask Brain, confirm the concept. Pending P8-17: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'N7',
  persona: 'nadia',
  goal: 'Drop the Q3 planning PDF and a pasted action list into the Engineering inbox, watch the Archivist file them, ask Brain, confirm the concept.',
  markers: ['A', 'B'],
  start: 'week-2',
  pending: 'P8-17',
  steps: [
    { id: 'drop-pdf', expect: 'inbox-dropzone', pending: 'P8-17' },
    { id: 'archivist-files', expect: 'inbox-list', pending: 'P8-17' },
    { id: 'ask-brain', expect: 'chat-screen', pending: 'P8-17' },
    { id: 'confirm-concept', expect: 'concept-detail', pending: 'P8-17' },
  ],
  outcome: async () => undefined,
});
