// R6 · Approve a leave request as a delegate from a push notification. Pending P11-06: mobile push is not built. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'R6',
  persona: 'rafi',
  goal: 'Approve a leave request as a delegate from a push notification.',
  markers: [],
  start: 'week-2',
  pending: 'P11-06',
  steps: [
    { id: 'push', expect: 'app-frame', pending: 'P11-06' },
    { id: 'approved', expect: 'approvals-inbox', pending: 'P11-06' },
  ],
  outcome: async () => undefined,
});
