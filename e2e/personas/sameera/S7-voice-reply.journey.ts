// S7 · Record a voice reply in a customer thread and read its transcript. Pending P14-17: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S7',
  persona: 'sameera',
  goal: 'Record a voice reply in a customer thread and read its transcript.',
  markers: [],
  start: 'week-2',
  pending: 'P14-17',
  steps: [
    { id: 'record', expect: 'app-frame', pending: 'P14-17' },
    { id: 'preview', expect: 'app-frame', pending: 'P14-17' },
    { id: 'transcript', expect: 'app-frame', pending: 'P14-17' },
  ],
  outcome: async () => undefined,
});
