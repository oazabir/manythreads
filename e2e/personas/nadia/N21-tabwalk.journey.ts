// N21 · The keyboard walk of Nadia's main screens (PLAN P13-01): from the top of the page, Tab through the first 15 stops. Every stop must show a focus ring and say what it is.
// Problems the walk finds are listed in KNOWN with their cause, so a fixed one makes this journey ask for the list to be cut and a new one fails it.
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { tabWalkSteps } from './support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines, each with its cause as a comment. */
const KNOWN: Record<string, readonly string[]> = {};

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
  outcome: async () => {
    walk.check();
  },
});
