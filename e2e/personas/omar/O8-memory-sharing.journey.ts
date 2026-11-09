// O8 · Share the Release notes digest with Customer support and Marketing, accept it for Customer support, approve the digest, release one held email and discard another. Pending P8-26: the Memory Sharing tab is written in the working tree but not committed or deployed. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O8',
  persona: 'omar',
  goal: 'Share the Release notes digest with Customer support and Marketing, accept it for Customer support, approve the digest, release one held email and discard another.',
  markers: ['A', 'B'],
  start: 'week-2',
  pending: 'P8-26',
  steps: [
    { id: 'share-written', expect: 'app-frame', pending: 'P8-26' },
    { id: 'marketing-waiting', expect: 'app-frame', pending: 'P8-26' },
    { id: 'accepted', expect: 'app-frame', pending: 'P8-26' },
    { id: 'digest-approved', expect: 'approvals-inbox', pending: 'P8-26' },
    { id: 'held-mail', expect: 'app-frame', pending: 'P8-26' },
  ],
  outcome: async () => undefined,
});
