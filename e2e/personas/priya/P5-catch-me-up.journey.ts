// P5 · Join a room late and use Catch me up, then read the morning brief. Pending P18-05: Catch me up and the morning brief are not built. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'P5',
  persona: 'priya',
  goal: 'Join a room late and use Catch me up, then read the morning brief.',
  markers: ['B'],
  start: 'week-2',
  pending: 'P18-05',
  steps: [
    { id: 'late-join', expect: 'app-frame', pending: 'P18-05' },
    { id: 'catch-me-up', expect: 'app-frame', pending: 'P18-05' },
    { id: 'morning-brief', expect: 'app-frame', pending: 'P18-05' },
  ],
  outcome: async () => undefined,
});
