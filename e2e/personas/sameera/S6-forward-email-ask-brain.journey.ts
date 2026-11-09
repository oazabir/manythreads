// S6 · Sameera forwards a customer email to her team's inbox address, then asks Brain what Engineering shipped: the answer cites Engineering's digest as "from Engineering · unverified" and she confirms it
// (PLAN block B, S6, markers A and B). Pending P8-19 (the email door; the digest she receives is P8-25): the mail door and the received digest are not part of the stand-in stack. The journey is declared and
// counted but takes no pictures (PLAN P12-03, rule E33). (An earlier draft of this file built a weekly digest; that is Engineering's side of the share, not the plan's S6.)
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S6',
  persona: 'sameera',
  goal: 'Forward a customer email to our team inbox address, then ask Brain what Engineering shipped and confirm the digest it cites.',
  markers: ['A', 'B'],
  start: 'week-2',
  pending: 'P8-19',
  steps: [
    { id: 'forward-email', expect: 'inbox-list', pending: 'P8-19' },
    { id: 'mail-filed', expect: 'inbox-list', pending: 'P8-19' },
    { id: 'ask-what-shipped', expect: 'chat-screen', pending: 'P8-25' },
    { id: 'cited-from-engineering', expect: 'answer', pending: 'P8-25' },
    { id: 'confirm-concept', expect: 'concept-detail', pending: 'P8-25' },
  ],
  outcome: async () => undefined,
});
