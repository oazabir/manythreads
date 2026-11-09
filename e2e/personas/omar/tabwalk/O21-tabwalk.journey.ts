// O21 · The keyboard walk of Omar's main screens (PLAN P13-01): from the top of the page, Tab through the first 15 stops. Every stop must show a focus ring and say what it is.
// Problems the walk finds are listed in KNOWN with their cause, so a fixed one makes this journey ask for the list to be cut and a new one fails it.
import { defineJourney } from '../../harness/journey.ts';
import { TID } from '../../../pages/index.ts';
import { tabWalkSteps } from '../support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines, each with its cause as a comment. */
const KNOWN: Record<string, readonly string[]> = {
  // FINDING (product, phone layout only): the message list (role=log, focusable) shows no focus ring when it takes focus
  'mobile:channel': ['stop 11 (log "Messages in #dev") shows no focus ring'],
  // HELPER FALSE POSITIVES (reported to the lead): the walk names a control by aria-label or text only; these inputs are named by a <label> ("From"/"To" dates, "Kind", "Search people", ...)
  'mobile:audit': ['stop 15 (input) has no name for a screen reader'],
  'mobile:llm': [
    'stop 6 (input) has no name for a screen reader',
    'stop 8 (input) has no name for a screen reader',
    'stop 9 (input) has no name for a screen reader',
    'stop 10 (input) has no name for a screen reader',
    'stop 11 (llm-provider-local) has no name for a screen reader',
  ],
  'mobile:members': ['stop 4 (members-search) has no name for a screen reader'],
};

const walk = tabWalkSteps(
  [
    { id: 'threads', path: '/t/engineering/threads', expect: TID.threadsInbox },
    { id: 'channel', path: '/t/engineering/c/dev', expect: TID.channelView },
    { id: 'approvals', path: '/t/engineering/approvals', expect: TID.approvalsInbox },
    { id: 'bots', path: '/t/engineering/bots', expect: TID.botsRoster },
    { id: 'boards', path: '/t/engineering/boards', expect: TID.boardsScreen },
    { id: 'audit', path: '/settings/workspace/audit', expect: TID.auditTable },
    { id: 'llm', path: '/settings/workspace/llm', expect: TID.llmAliases },
    { id: 'members', path: '/settings/workspace/members', expect: TID.membersSearch },
  ],
  KNOWN,
);

export default defineJourney({
  id: 'O21',
  persona: 'omar',
  goal: 'Reach every control on my screens with the keyboard alone and always see where focus is.',
  markers: [],
  start: 'week-2',
  steps: walk.steps,
  outcome: async ({ viewport }) => {
    walk.check(viewport);
  },
});
