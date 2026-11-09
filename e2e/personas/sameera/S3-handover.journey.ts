// S3 · Hand a customer thread to Engineering without giving them the Support customer data. Pending P8-10: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S3',
  persona: 'sameera',
  goal: 'Hand a customer thread to Engineering without giving them the Support customer data.',
  markers: [],
  start: 'week-2',
  pending: 'P8-10',
  steps: [
    { id: 'open-thread', expect: 'thread-view', pending: 'P8-10' },
    { id: 'hand-over', expect: 'app-frame', pending: 'P8-10' },
    { id: 'engineering-card', expect: 'app-frame', pending: 'P8-10' },
  ],
  outcome: async () => undefined,
});
