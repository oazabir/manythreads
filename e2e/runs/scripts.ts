import type { Action } from '../../tools/fake-acp-agent/src/script.ts';

/*
 * What the fake agent does in each run of the run card proofs (PLAN P25-12). One script, `default`, is put in the environment of the bridge before a person asks; the agent that the bridge
 * starts for that run plays it. Paths are relative to the bridge's working folder, so the card shows file names only.
 */

const THREAD = 'clients/web/src/channels/ThreadPanel.tsx';

/** Reads some files, asks a helper, makes a plan, waits for a person to allow a command, edits a file and answers. */
export const JOURNEY: Action[] = [
  { do: 'thought', text: 'I will read the code first.' },
  { do: 'step', title: 'Read ThreadPanel.tsx', kind: 'read', paths: [THREAD], ms: 1200 },
  { do: 'step', title: 'Read MessageRow.tsx', kind: 'read', paths: ['clients/web/src/channels/MessageRow.tsx'] },
  { do: 'step', title: 'Read hooks.ts', kind: 'read', paths: ['clients/web/src/channels/hooks.ts'] },
  { do: 'step', title: 'Read store.ts', kind: 'read', paths: ['clients/web/src/channels/store.ts'] },
  {
    do: 'helper',
    name: 'Check the tests',
    steps: [
      { title: 'Read thread.test.ts', kind: 'read', paths: ['clients/web/test/thread.test.ts'], ms: 500 },
      { title: 'Searched for useThreadRuns', kind: 'search', ms: 300 },
    ],
    report: 'The tests cover it.',
  },
  {
    do: 'plan',
    entries: [
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the change', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
    ],
  },
  { do: 'permission', step: { title: 'pnpm test', kind: 'execute', toolName: 'Bash' }, onReject: [{ do: 'text', text: 'I did not run the tests.' }] },
  { do: 'step', title: 'Edit ThreadPanel.tsx', kind: 'edit', paths: [THREAD], diff: { path: THREAD, oldText: 'const a = 1;', newText: 'const a = 1;\nconst b = 2;' } },
  { do: 'text', text: 'All done.\n\nThe tests pass.' },
  { do: 'usage', cost: 0.12 },
];

/** A command that runs for a minute: a person has time to press Stop. */
export const SLOW: Action[] = [
  { do: 'text', text: 'Starting the full test run.' },
  { do: 'step', title: 'Read package.json', kind: 'read', paths: ['package.json'] },
  { do: 'step', title: 'pnpm test', kind: 'execute', toolName: 'Bash', ms: 60_000 },
];

/** Does a little work and then the agent fails. */
export const FAILS: Action[] = [
  { do: 'step', title: 'Read ThreadPanel.tsx', kind: 'read', paths: [THREAD] },
  { do: 'step', title: 'Read hooks.ts', kind: 'read', paths: ['clients/web/src/channels/hooks.ts'] },
  { do: 'fail', message: 'The agent stopped on an internal error' },
];

/**
 * The orchestrator: it makes a plan of its own (which its run card must not draw, as the to-do card is its plan) and stays on one slow step while the spec writes its to-do list
 * through its own tool endpoint. The step outlasts the test on a loaded box; the spec stops the run when it is done with it.
 */
export const ORCHESTRATE: Action[] = [
  { do: 'text', text: 'Splitting the request into parts.' },
  { do: 'plan', entries: [{ content: 'Plan the parts', status: 'completed' }, { content: 'Hand the cards out', status: 'in_progress' }] },
  { do: 'step', title: 'Read the list of cards', kind: 'read', paths: ['docs/cards.md'], ms: 600_000 },
];

const LONG = 'Rewrite the run card so the plan, the step list and the folded end line read well for engineers and for people who never read code, in light and dark';

/**
 * The edge cases of the card's look (P25-11 polish): a run that has not done a step yet (Starting), Arabic and very long words, a plan with long items, five helpers, a step that
 * failed, file names in Arabic, and then one command that runs for ten minutes (the spec moves the page's clock on two hours, then stops it).
 */
export const EDGE: Action[] = [
  { do: 'sleep', ms: 6_000 },
  { do: 'thought', text: 'Reading first.' },
  { do: 'text', text: 'سأقرأ الكود أولاً ثم أكتب التغيير وأشغّل الاختبارات.\n\nThen I will check every screen in light and dark, at 390 px and on a wide screen, before I say it is done.' },
  {
    do: 'plan',
    entries: [
      { content: 'Read the code', status: 'completed' },
      { content: LONG, status: 'in_progress' },
      { content: 'مراجعة النص العربي في البطاقة', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ],
  },
  { do: 'step', title: 'Read ThreadPanel.tsx', kind: 'read', paths: [THREAD] },
  { do: 'step', title: 'Read MessageRow.tsx', kind: 'read', paths: ['clients/web/src/channels/MessageRow.tsx'] },
  { do: 'step', title: 'Read واجهة-المستخدم.md', kind: 'read', paths: ['docs/واجهة-المستخدم.md'] },
  { do: 'step', title: 'Searched for useThreadRuns', kind: 'search' },
  ...['Check the tests', 'Review the words', 'Look at dark mode', 'مراجعة الاتجاه من اليمين', 'Measure the phone layout'].map(
    (name, i): Action => ({ do: 'helper', name, steps: [{ title: `Read part${i}.ts`, kind: 'read', paths: [`clients/web/src/part${i}.ts`], ms: 100 }], report: 'Fine.' }),
  ),
  { do: 'step', title: `Edit ${'RunCardWithAVeryLongFileNameThatGoesOnAndOn'.repeat(2)}.tsx`, kind: 'edit', paths: [`clients/web/src/${'RunCardWithAVeryLongFileNameThatGoesOnAndOn'.repeat(2)}.tsx`], diff: { path: THREAD, oldText: 'a', newText: 'a\nb\nc' } },
  { do: 'step', title: 'pnpm lint', kind: 'execute', toolName: 'Bash', fail: 'lint failed' },
  { do: 'step', title: 'pnpm test', kind: 'execute', toolName: 'Bash', ms: 600_000 },
];
