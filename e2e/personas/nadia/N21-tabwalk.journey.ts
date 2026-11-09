// N21 · The keyboard walk of Nadia's main screens (PLAN P13-01): from the top of the page, Tab through the first 15 stops. Every stop must show a focus ring and say what it is.
// Problems the walk finds are listed in KNOWN with their cause, so a fixed one makes this journey ask for the list to be cut and a new one fails it.
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { tabWalkSteps } from './support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines, each with its cause as a comment. */
const KNOWN: Record<string, readonly string[]> = {
  // PRODUCT FINDING (phone layout only): the message list is a scrolling role="log" with tabIndex 0 and no focus style of its own (clients/web/src/channels/VirtualList.tsx); at 390 px
  // the folded sidebar brings it into the first 15 stops and it takes focus with no ring (the wide screen reaches it after the 15th stop)
  'mobile:channel': ['stop 11 (log "Messages in #dev") shows no focus ring'],
  // PRODUCT FINDING (phone layout only): the Brain message box takes focus with no ring at 390 px (the wide screen draws one)
  'mobile:brain': ['stop 13 (textarea "Message Brain") shows no focus ring'],
};

const walk = tabWalkSteps(
  [
    { id: 'threads', path: '/t/engineering/threads', expect: TID.threadsInbox },
    { id: 'channel', path: '/t/engineering/c/dev', expect: TID.channelView },
    { id: 'brain', path: '/t/engineering/chat', expect: TID.chatScreen },
    { id: 'boards', path: '/t/engineering/boards', expect: TID.frame },
    { id: 'approvals', path: '/t/engineering/approvals', expect: TID.approvalsInbox },
  ],
  KNOWN,
);

export default defineJourney({
  id: 'N21',
  persona: 'nadia',
  goal: 'Reach every control on my main screens with the keyboard alone and always see where focus is.',
  markers: [],
  start: 'week-2',
  steps: walk.steps,
  outcome: async ({ viewport }) => {
    walk.check(viewport);
  },
});
