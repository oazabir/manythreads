// R5 · Start an incident with /incident: the channel, the on-call paged, a voice room and a postmortem drafted. Pending P18-07: `/incident` (channel, page, voice room, postmortem) is not built; the incident recipe of the gallery (P18-01) is only its template. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'R5',
  persona: 'rafi',
  goal: 'Start an incident with /incident: the channel, the on-call paged, a voice room and a postmortem drafted.',
  markers: ['A'],
  start: 'week-2',
  pending: 'P18-07',
  steps: [
    { id: 'incident-started', expect: 'app-frame', pending: 'P18-07' },
    { id: 'oncall-paged', expect: 'app-frame', pending: 'P18-07' },
    { id: 'postmortem', expect: 'app-frame', pending: 'P18-07' },
  ],
  outcome: async () => undefined,
});
