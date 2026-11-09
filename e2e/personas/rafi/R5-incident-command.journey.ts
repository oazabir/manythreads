// R5 · Start an incident with /incident: the channel, the on-call paged, a voice room and a postmortem drafted. Pending P18-01: the incident recipe is part of the recipe gallery that is partly built. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'R5',
  persona: 'rafi',
  goal: 'Start an incident with /incident: the channel, the on-call paged, a voice room and a postmortem drafted.',
  markers: ['A'],
  start: 'week-2',
  pending: 'P18-01',
  steps: [
    { id: 'incident-started', expect: 'app-frame', pending: 'P18-01' },
    { id: 'oncall-paged', expect: 'app-frame', pending: 'P18-01' },
    { id: 'postmortem', expect: 'app-frame', pending: 'P18-01' },
  ],
  outcome: async () => undefined,
});
