// O4 · Add the Content drafter from a brief, rehearse it, and approve it into the roster. Pending P7-04: the Add a bot flow is partly built (discovery with grades and the proposal step). The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O4',
  persona: 'omar',
  goal: 'Add the Content drafter from a brief, rehearse it, and approve it into the roster.',
  markers: ['A'],
  start: 'week-2',
  pending: 'P7-04',
  steps: [
    { id: 'brief', expect: 'app-frame', pending: 'P7-04' },
    { id: 'rehearse', expect: 'app-frame', pending: 'P7-04' },
    { id: 'approved', expect: 'bots-roster', pending: 'P7-04' },
  ],
  outcome: async () => undefined,
});
