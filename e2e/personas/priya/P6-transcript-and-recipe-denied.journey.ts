// P6 · Open the transcript URL of a private channel (403) and try to install a recipe (refused). Pending P15-09 (the transcript in the meetings folder; the recipe half is P18-01): a transcript needs a meeting held in a private channel, and the stack has no media server to hold one. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'P6',
  persona: 'priya',
  goal: 'Open the transcript URL of a private channel (403) and try to install a recipe (refused).',
  markers: [],
  start: 'week-2',
  pending: 'P15-09',
  steps: [
    { id: 'transcript-refused', expect: 'no-access', pending: 'P15-09' },
    { id: 'recipe-refused', expect: 'app-frame', pending: 'P18-01' },
  ],
  outcome: async () => undefined,
});
