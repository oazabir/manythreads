// S6 · Build the weekly digest from the memory of my team and read what would be shared before anything leaves. Pending P8-23: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S6',
  persona: 'sameera',
  goal: 'Build the weekly digest from the memory of my team and read what would be shared before anything leaves.',
  markers: ['B'],
  start: 'week-2',
  pending: 'P8-23',
  steps: [
    { id: 'build-digest', expect: 'app-frame', pending: 'P8-23' },
    { id: 'read-bundle', expect: 'app-frame', pending: 'P8-23' },
    { id: 'ready', expect: 'app-frame', pending: 'P8-23' },
  ],
  outcome: async () => undefined,
});
