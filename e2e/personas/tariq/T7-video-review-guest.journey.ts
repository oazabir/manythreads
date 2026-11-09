// T7 · Tariq holds a video review with an outside guest admitted from the waiting room; the follow-up email leaves only after he approves it. Pending P17-04: guest links and the waiting room are not built yet (P17-04), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';
import { TARIQ_ENV } from './support/index.ts';

export default defineJourney({
  id: 'T7',
  persona: 'tariq',
  goal: 'Tariq holds a video review with an outside guest admitted from the waiting room; the follow-up email leaves only after he approves it.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  pending: 'P17-04',
  steps: [
    { id: 'start-review', expect: 'app-frame', pending: 'P17-04' },
    { id: 'guest-waiting', expect: 'app-frame', pending: 'P17-04' },
    { id: 'guest-admitted', expect: 'app-frame', pending: 'P17-04' },
    { id: 'follow-up-approved', expect: 'app-frame', pending: 'P17-04' },
  ],
  outcome: async () => undefined,
});
