// O11 · Connect Google for the workspace OAuth app and offboard a leaver. Pending P18-08: offboarding is not built and Google answers only through a fake. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O11',
  persona: 'omar',
  goal: 'Connect Google for the workspace OAuth app and offboard a leaver.',
  markers: [],
  start: 'week-2',
  pending: 'P18-08',
  steps: [
    { id: 'connect-google', expect: 'app-frame', pending: 'P18-08' },
    { id: 'offboard', expect: 'app-frame', pending: 'P18-08' },
  ],
  outcome: async () => undefined,
});
