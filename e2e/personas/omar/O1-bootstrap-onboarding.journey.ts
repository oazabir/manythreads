// O1 · Bootstrap a new workspace, go through onboarding steps 0 to 8, and put the first goal to Brain. Pending P10-01: the steps need a stack that starts without a workspace (the harness gives an anonymous window only for start empty) and the checklist is partly built. The journey is declared and counted but takes no pictures (PLAN P12-03, rule E33).
import { defineJourney } from '../harness/journey.ts';

export default defineJourney({
  id: 'O1',
  persona: 'omar',
  goal: 'Bootstrap a new workspace, go through onboarding steps 0 to 8, and put the first goal to Brain.',
  markers: ['B'],
  start: 'week-2',
  pending: 'P10-01',
  steps: [
    { id: 'wizard', expect: 'app-frame', pending: 'P10-01' },
    { id: 'provider', expect: 'app-frame', pending: 'P10-01' },
    { id: 'first-goal', expect: 'chat-screen', pending: 'P10-01' },
  ],
  outcome: async () => undefined,
});
