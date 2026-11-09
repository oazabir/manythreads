// T5 · ImageGenerator makes pictures for a post; Tariq picks one and saves it as an attachment. Pending P9-08: ImageGenerator is not in the web client yet (P9-08), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';
import { TARIQ_ENV } from './support/index.ts';

export default defineJourney({
  id: 'T5',
  persona: 'tariq',
  goal: 'ImageGenerator makes pictures for a post; Tariq picks one and saves it as an attachment.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  pending: 'P9-08',
  steps: [
    { id: 'ask-image', expect: 'app-frame', pending: 'P9-08' },
    { id: 'pick-image', expect: 'app-frame', pending: 'P9-08' },
    { id: 'saved-attachment', expect: 'app-frame', pending: 'P9-08' },
  ],
  outcome: async () => undefined,
});
