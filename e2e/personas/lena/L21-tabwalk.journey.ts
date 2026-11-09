// L21 · The keyboard walk of Lena's main screens (PLAN P13-01): from the top of the page, Tab through the first 15 stops. Every stop must show a focus ring and say what it is.
// Problems the walk finds are listed in KNOWN with their cause, so a fixed one makes this journey ask for the list to be cut and a new one fails it.
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LENA_ENV } from './support/index.ts';
import { tabWalkSteps, type KnownProblem } from './support/sweep.ts';

/** Problems found by the walk and not fixed yet: step id -> the problem lines, each with its cause as a comment. */
const KNOWN: Record<string, readonly KnownProblem[]> = {
  // PRODUCT FINDING: the message list is a scrolling `role="log"` with `tabIndex={0}` (clients/web/src/channels/VirtualList.tsx) and no focus style of its own, so the keyboard
  // reaches it with nothing to show where focus is. It is the same list on every channel screen.
  releases: ['stop 11 (log "Messages in #releases") shows no focus ring'],
};

const walk = tabWalkSteps(
  [
    { id: 'releases', path: '/t/engineering/c/releases', expect: TID.readOnly },
    { id: 'search', path: '/t/engineering/search?q=deploy', expect: TID.searchResults },
    // at 390 px the page that says she may not open the channel has the top bar and one way back: three stops
    { id: 'no-access', path: '/t/engineering/c/dev', expect: TID.noAccess, minStops: { mobile: 3 } },
  ],
  KNOWN,
);

export default defineJourney({
  id: 'L21',
  persona: 'lena',
  goal: 'Reach every control on my screens with the keyboard alone and always see where focus is.',
  markers: [],
  start: 'week-2',
  stackEnv: LENA_ENV,
  steps: walk.steps,
  fewerShots: 'a guest has three screens: the channel she may read, search, and the page that says she may not open a channel',
  outcome: async ({ viewport }) => {
    walk.check(viewport);
  },
});
