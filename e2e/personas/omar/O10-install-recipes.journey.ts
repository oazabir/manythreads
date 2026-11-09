// O10 · Install the stand-up and incident recipes as proposals and approve them. Pending P18-01: the recipe gallery is partly built. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O10',
  persona: 'omar',
  goal: 'Install the stand-up and incident recipes as proposals and approve them.',
  markers: ['A'],
  start: 'week-2',
  pending: 'P18-01',
  steps: [
    { id: 'gallery', expect: 'app-frame', pending: 'P18-01' },
    { id: 'proposals', expect: 'app-frame', pending: 'P18-01' },
    { id: 'approved', expect: 'app-frame', pending: 'P18-01' },
  ],
  outcome: async () => undefined,
});
