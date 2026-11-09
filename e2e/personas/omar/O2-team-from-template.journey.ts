// O2 · Create Customer support from the template, invite Sameera and tag her role:support-agent. Pending P8-10: the Support template is partly built (its responder bot is not part of the stand-in stack). The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O2',
  persona: 'omar',
  goal: 'Create Customer support from the template, invite Sameera and tag her role:support-agent.',
  markers: [],
  start: 'week-2',
  pending: 'P8-10',
  steps: [
    { id: 'new-team', expect: 'app-frame', pending: 'P8-10' },
    { id: 'invite', expect: 'app-frame', pending: 'P8-10' },
    { id: 'role-tag', expect: 'app-frame', pending: 'P8-10' },
  ],
  outcome: async () => undefined,
});
