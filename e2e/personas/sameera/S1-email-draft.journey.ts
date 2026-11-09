// S1 · A customer email arrives, Support responder drafts a reply, I approve it and it is sent. Pending P8-19: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S1',
  persona: 'sameera',
  goal: 'A customer email arrives, Support responder drafts a reply, I approve it and it is sent.',
  markers: ['A'],
  start: 'week-2',
  pending: 'P8-19',
  steps: [
    { id: 'email-arrives', expect: 'app-frame', pending: 'P8-19' },
    { id: 'draft-ready', expect: 'approval-card', pending: 'P8-19' },
    { id: 'approve-and-send', expect: 'approval-outcome', pending: 'P8-19' },
  ],
  outcome: async () => undefined,
});
