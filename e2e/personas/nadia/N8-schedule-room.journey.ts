// N8 · Schedule a room from a channel with my calendar. Pending P16-05: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'N8',
  persona: 'nadia',
  goal: 'Schedule a room from a channel with my calendar.',
  markers: [],
  start: 'week-2',
  pending: 'P16-05',
  steps: [
    { id: 'schedule-room', expect: 'channel-view', pending: 'P16-05' },
    { id: 'calendar-event', expect: 'app-frame', pending: 'P16-05' },
    { id: 'room-card', expect: 'channel-view', pending: 'P16-05' },
  ],
  outcome: async () => undefined,
});
