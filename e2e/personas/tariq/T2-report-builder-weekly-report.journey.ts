// T2 · ReportBuilder writes the weekly report; Tariq pins it to #analytics and exports it. Pending P9-08: ReportBuilder and the pin and export of a report are not in the web client yet (P9-08 builds ReportBuilder, P9-09 the pin and export), so the journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';
import { TARIQ_ENV } from './support/index.ts';

export default defineJourney({
  id: 'T2',
  persona: 'tariq',
  goal: 'ReportBuilder writes the weekly report; Tariq pins it to #analytics and exports it.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  pending: 'P9-08',
  steps: [
    { id: 'ask-report', expect: 'app-frame', pending: 'P9-08' },
    { id: 'report-built', expect: 'app-frame', pending: 'P9-08' },
    { id: 'pin-to-channel', expect: 'app-frame', pending: 'P9-08' },
    { id: 'export', expect: 'app-frame', pending: 'P9-08' },
  ],
  outcome: async () => undefined,
});
