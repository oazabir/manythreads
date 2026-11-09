// R21 · The keyboard walk of Rafi's main screens (PLAN P13-01): from the top of the page, Tab through the first 15 stops. Every stop must show a focus ring and say what it is.
// Problems the walk finds are listed in KNOWN with their cause, so a fixed one makes this journey ask for the list to be cut and a new one fails it.
import { defineJourney } from '../../harness/journey.ts';
import { TID } from '../../../pages/index.ts';
import { tabWalkSteps } from '../../omar/support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines, each with its cause as a comment. */
const KNOWN: Record<string, readonly string[]> = {
  // FINDING (product, phone layout only): the message list (role=log, focusable) and the Brain message box show no focus ring when they take focus
  'mobile:incidents': ['stop 10 (log "Messages in #incidents") shows no focus ring'],
  'mobile:brain': ['stop 13 (textarea "Message Brain") shows no focus ring'],
};

const walk = tabWalkSteps(
  [
    { id: 'approvals', path: '/t/engineering/approvals', expect: TID.approvalsInbox },
    { id: 'threads', path: '/t/engineering/threads', expect: TID.threadsInbox },
    { id: 'incidents', path: '/t/engineering/c/incidents', expect: TID.channelView },
    { id: 'bots', path: '/t/engineering/bots', expect: TID.botsRoster },
    { id: 'brain', path: '/t/engineering/chat?bot=brain', expect: TID.chatScreen },
  ],
  KNOWN,
);

export default defineJourney({
  id: 'R21',
  persona: 'rafi',
  goal: 'Reach every control on my screens with the keyboard alone and always see where focus is.',
  markers: [],
  start: 'week-2',
  steps: walk.steps,
  outcome: async ({ viewport }) => {
    walk.check(viewport);
  },
});
