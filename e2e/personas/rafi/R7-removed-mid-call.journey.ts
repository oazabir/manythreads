// R7 · Be removed from a channel in the middle of a call and be dropped from the room. Pending P15-02 (a removed person is kicked from the room within 5 s): there is no media server in the stack, so a call has no live room to drop him from. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'R7',
  persona: 'rafi',
  goal: 'Be removed from a channel in the middle of a call and be dropped from the room.',
  markers: [],
  start: 'week-2',
  pending: 'P15-02',
  steps: [
    { id: 'in-call', expect: 'app-frame', pending: 'P15-02' },
    { id: 'removed', expect: 'app-frame', pending: 'P15-02' },
    { id: 'dropped', expect: 'app-frame', pending: 'P15-02' },
  ],
  outcome: async () => undefined,
});
