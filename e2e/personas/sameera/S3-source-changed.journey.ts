// S3 · A manual changes after Brain answered from it: the old answer shows "source changed since", and the question Brain could not answer goes to #kb-updates (PLAN block B, S3, marker B).
// Pending P8-08: the sync detects the change and bumps the version, but "source changed since" is not shown in the web Answer and a declined question is not routed to #kb-updates yet. The journey is declared
// and counted but takes no pictures (PLAN P12-03, rule E33). (An earlier draft of this file described a handover to Engineering; that is not the plan's S3.)
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'S3',
  persona: 'sameera',
  goal: 'Ask Brain a question from the manuals, then see that the answer says its source changed since, and that the question Brain could not answer reached #kb-updates.',
  markers: ['B'],
  start: 'week-2',
  pending: 'P8-08',
  steps: [
    { id: 'answer-from-manual', expect: 'answer', pending: 'P8-08' },
    { id: 'manual-changes', expect: 'app-frame', pending: 'P8-08' },
    { id: 'source-changed-since', expect: 'answer', pending: 'P8-08' },
    { id: 'gap-in-kb-updates', expect: 'channel-view', pending: 'P8-08' },
  ],
  outcome: async () => undefined,
});
