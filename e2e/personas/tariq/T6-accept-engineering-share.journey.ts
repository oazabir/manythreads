// T6 · Tariq accepts Engineering's share for Marketing, reads the received digest and asks Brain about it. Pending P8-26: the sharing web screens and the seed that offers a share to Marketing are not built yet (P8-26, P8-27), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';
import { TARIQ_ENV } from './support/index.ts';

export default defineJourney({
  id: 'T6',
  persona: 'tariq',
  goal: "Tariq accepts Engineering's share for Marketing, reads the received digest and asks Brain about it.",
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  pending: 'P8-26',
  steps: [
    { id: 'share-waiting', expect: 'app-frame', pending: 'P8-26' },
    { id: 'share-accepted', expect: 'app-frame', pending: 'P8-26' },
    { id: 'digest-read', expect: 'app-frame', pending: 'P8-26' },
    { id: 'ask-brain-about-it', expect: 'app-frame', pending: 'P8-26' },
  ],
  outcome: async () => undefined,
});
