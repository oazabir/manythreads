// T8 · Tariq translates a Bangla message. Pending P18-10: Translate is not built yet (P18-10), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';
import { TARIQ_ENV } from './support/index.ts';

export default defineJourney({
  id: 'T8',
  persona: 'tariq',
  goal: 'Tariq translates a Bangla message.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  pending: 'P18-10',
  steps: [
    { id: 'bangla-message', expect: 'app-frame', pending: 'P18-10' },
    { id: 'translated', expect: 'app-frame', pending: 'P18-10' },
  ],
  outcome: async () => undefined,
});
