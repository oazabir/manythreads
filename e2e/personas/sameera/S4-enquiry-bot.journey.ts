// S4 · Watch the enquiry bot answer a public question from the manuals and hand a hard one to me. Pending P8-10: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S4',
  persona: 'sameera',
  goal: 'Watch the enquiry bot answer a public question from the manuals and hand a hard one to me.',
  markers: ['A'],
  start: 'week-2',
  pending: 'P8-10',
  steps: [
    { id: 'public-question', expect: 'app-frame', pending: 'P8-10' },
    { id: 'bot-answers', expect: 'app-frame', pending: 'P8-10' },
    { id: 'hard-one-to-me', expect: 'thread-view', pending: 'P8-10' },
  ],
  outcome: async () => undefined,
});
