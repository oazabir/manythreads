// T21 · The keyboard walk of Tariq's main screens (PLAN P13-01): from the top of the page, Tab through the first 15 stops. Every stop must show a focus ring and say what it is.
// Problems the walk finds are listed in KNOWN with their cause, so a fixed one makes this journey ask for the list to be cut and a new one fails it.
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { TARIQ_ENV } from './support/index.ts';
import { tabWalkSteps, type KnownProblem } from './support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines, each with its cause as a comment. */
const KNOWN: Record<string, readonly KnownProblem[]> = {
  // PRODUCT FINDING: the message list is a scrolling `role="log"` with `tabIndex={0}` (clients/web/src/channels/VirtualList.tsx) and no focus style of its own, so the keyboard
  // reaches it with nothing to show where focus is. On the wide screen it comes after the 15th stop; at 390 px the folded sidebar brings it in range.
  // PRODUCT FINDING: at 390 px the Brain message box takes focus without a ring (the wide screen draws one).
  brain: [{ line: 'stop 1 (textarea "Message Brain") shows no focus ring', only: 'mobile' }],
  channel: [{ line: 'stop 10 (log "Messages in #content") shows no focus ring', only: 'mobile' }],
};

const walk = tabWalkSteps(
  [
    { id: 'threads', path: '/t/marketing/threads', expect: TID.threadsInbox },
    { id: 'channel', path: '/t/marketing/c/content', expect: TID.channelView },
    { id: 'brain', path: '/t/marketing/chat', expect: TID.chatScreen, from: 'a.skip-link' },
    { id: 'files', path: '/t/marketing/files', expect: TID.filesScreen },
    { id: 'jobs', path: '/t/marketing/jobs', expect: 'scheduled-jobs-screen' },
  ],
  KNOWN,
);

export default defineJourney({
  id: 'T21',
  persona: 'tariq',
  goal: 'Reach every control on my main screens with the keyboard alone and always see where focus is.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  steps: walk.steps,
  outcome: async ({ viewport }) => {
    walk.check(viewport);
  },
});
