// S21 · The keyboard walk of Sameera's main screens (PLAN P13-01): Tab through the first 15 stops from the top of the page; every stop shows a focus ring and says what it is.
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { tabWalkSteps } from '../nadia/support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines. */
const KNOWN: Record<string, readonly string[]> = {};

const walk = tabWalkSteps(
  [
    { id: 'threads', path: '/t/customer-support/threads', expect: TID.threadsInbox },
    { id: 'support-channel', path: '/t/customer-support/c/support', expect: TID.channelView },
    { id: 'brain', path: '/t/customer-support/chat', expect: TID.chatScreen },
    { id: 'approvals', path: '/t/customer-support/approvals', expect: TID.approvalsInbox },
    { id: 'bots', path: '/t/customer-support/bots', expect: TID.botsRoster },
  ],
  KNOWN,
);

export default defineJourney({
  id: 'S21',
  persona: 'sameera',
  goal: 'Reach every control on my Support screens with the keyboard alone and always see where focus is.',
  markers: [],
  start: 'week-2',
  steps: walk.steps,
  outcome: async () => {
    walk.check();
  },
});
