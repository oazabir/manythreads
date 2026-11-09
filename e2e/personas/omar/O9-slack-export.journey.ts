// O9 · Import a Slack export: dry run, import, restart midway, and the counts match. Pending P14-13: the import is built, but this pass wrote no export file to feed it and the harness has no restart step. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O9',
  persona: 'omar',
  goal: 'Import a Slack export: dry run, import, restart midway, and the counts match.',
  markers: [],
  start: 'week-2',
  pending: 'P14-13',
  steps: [
    { id: 'dry-run', expect: 'app-frame', pending: 'P14-13' },
    { id: 'import', expect: 'app-frame', pending: 'P14-13' },
    { id: 'restarted', expect: 'app-frame', pending: 'P14-13' },
    { id: 'counts', expect: 'app-frame', pending: 'P14-13' },
  ],
  outcome: async () => undefined,
});
