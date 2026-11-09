// N6 · Connect Drive, ask Brain about a file in it, and share the answer to #releases with the private parts masked. Pending P8-02: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'N6',
  persona: 'nadia',
  goal: 'Connect Drive, ask Brain about a file in it, and share the answer to #releases with the private parts masked.',
  markers: ['B'],
  start: 'week-2',
  pending: 'P8-02',
  steps: [
    { id: 'connect-drive', expect: 'app-frame', pending: 'P8-02' },
    { id: 'ask-brain', expect: 'chat-screen', pending: 'P8-02' },
    { id: 'share-masked', expect: 'app-frame', pending: 'P8-02' },
    { id: 'releases-channel', expect: 'channel-view', pending: 'P8-02' },
  ],
  outcome: async () => undefined,
});
