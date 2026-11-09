// N4 · Co-edit the runbook page while Brain writes a section, read the history, restore an old version. Pending P6-09: this needs what that task delivers (or a stand-in the test stack does not have yet), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'N4',
  persona: 'nadia',
  goal: 'Co-edit the runbook page while Brain writes a section, read the history, restore an old version.',
  markers: ['B'],
  start: 'week-2',
  pending: 'P6-09',
  steps: [
    { id: 'page-open', expect: 'app-frame', pending: 'P6-09' },
    { id: 'brain-writes-section', expect: 'app-frame', pending: 'P6-09' },
    { id: 'history', expect: 'app-frame', pending: 'P6-09' },
    { id: 'restore', expect: 'app-frame', pending: 'P6-09' },
  ],
  outcome: async () => undefined,
});
