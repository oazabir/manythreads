import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action, FakeScript } from './script.ts';

/*
 * The engineering chain's bots as scripts for the fake ACP agent (P27-19): each one makes the platform tool calls the real bot makes (tasks, messages, to-do list,
 * hand-offs, `mt-publish`) over the run's own MCP address, so a browser test can say "the engineer answers with this script" and watch the board, the thread
 * and the to-do list change without a model or a pod. The text of each bot's reply names the bot and the marker `chain-ok`. Nothing here talks to a model.
 *
 * Use `chainScript('engineer')` for one bot's script (a `FakeScript` for `createFakeAcpAgent` or a JSON file for the CLI's `--script=`), or
 * `writeChainScripts(dir)` to write `<slug>.json` for every bot and point each bot's profile (`acp.args: ['--script=<dir>/<slug>.json']`) at its own file.
 */

export interface ChainOptions {
  /** The branch the cards are made on (default `chain-demo`). */
  branch?: string;
  /** The project name `mt-publish` is given (default `starter`). Only the committer script uses it. */
  project?: string;
  /** What the committer does after the check: `publish` (default) or `check` only, for a stack with no fake git host. */
  committer?: 'publish' | 'check';
}

/** The order the work moves in, and who gets the card next. */
export const CHAIN: ReadonlyArray<{ slug: string; next: string | null }> = [
  { slug: 'engineer', next: 'plan-reviewer' },
  { slug: 'plan-reviewer', next: 'coder' },
  { slug: 'coder', next: 'code-reviewer' },
  { slug: 'code-reviewer', next: 'tester' },
  { slug: 'tester', next: 'committer' },
  { slug: 'committer', next: 'deployer' },
  { slug: 'deployer', next: 'web-smoke-tester' },
  { slug: 'web-smoke-tester', next: null },
];

const say = (slug: string, what: string): Action => ({ do: 'text', text: `${slug}: ${what} chain-ok` });

/** The card the bot was woken with: its id is in the prompt the platform sends. */
const claim = (): Action => ({ do: 'mcp', tool: 'tasks.claim', args: { taskId: '{{promptId}}' }, title: 'Claim the card', store: 'claim' });
const handoff = (to: string, note: string, taskId = '{{promptId}}'): Action => ({ do: 'mcp', tool: 'tasks.handoff', args: { taskId, toBotSlug: to, note }, title: `Hand the card to ${to}` });

function engineer(o: Required<ChainOptions>): Action[] {
  return [
    { do: 'plan', entries: [{ content: 'Plan the work', status: 'in_progress' }, { content: 'Hand the first card to the next bot' }] },
    { do: 'mcp', tool: 'messages.search', args: { query: 'plan' }, title: 'Look for earlier plans' },
    { do: 'mcp', tool: 'boards.ensure', args: {}, title: 'Find the Bot Board', store: 'board' },
    { do: 'mcp', tool: 'messages.post', args: { text: 'Plan: 1. one small change, 2. review it, 3. test it, 4. publish it, 5. deploy it, 6. check the page.' }, title: 'Post the plan' },
    { do: 'mcp', tool: 'tasks.create', args: { title: 'Plan review: one small change', description: 'The plan is in the thread.', branch: o.branch, kind: 'other', boardId: '{{var:board.board.id}}' }, title: 'Create the plan review card', store: 'review' },
    { do: 'mcp', tool: 'tasks.create', args: { title: 'Make the small change', description: 'One page, one test.', branch: o.branch, kind: 'code', boardId: '{{var:board.board.id}}' }, title: 'Create the work card', store: 'work' },
    {
      do: 'mcp',
      tool: 'tasks.todo',
      args: {
        action: 'set',
        title: 'The plan',
        items: [
          { id: 'review', text: 'Review the plan', status: 'working', taskId: '{{var:review.task.id}}' },
          { id: 'work', text: 'Make the small change', status: 'waiting', taskId: '{{var:work.task.id}}' },
        ],
      },
      title: 'Write the to-do list',
    },
    handoff('plan-reviewer', 'Please review the plan in the thread.', '{{var:review.task.id}}'),
    say('engineer', 'planned the work and handed the plan to the reviewer.'),
  ];
}

const reviewer = (slug: string, next: string, what: string): Action[] => [claim(), { do: 'mcp', tool: 'tasks.read', args: { taskId: '{{promptId}}' }, title: 'Read the card' }, handoff(next, `${what}: approved.`), say(slug, `${what}: approved.`)];

function coder(): Action[] {
  return [
    claim(),
    { do: 'mcp', tool: 'tasks.read', args: { taskId: '{{promptId}}' }, title: 'Read the card' },
    { do: 'run', command: 'git status --short 2>/dev/null || true', title: 'Look at the working tree', store: 'tree' },
    { do: 'mcp', tool: 'tasks.describe', args: { taskId: '{{promptId}}', description: 'One page, one test. Made and ready for review.' }, title: 'Write the card back' },
    handoff('code-reviewer', 'The change is made; please review it.'),
    say('coder', 'made the change.'),
  ];
}

function committer(o: Required<ChainOptions>): Action[] {
  return [
    claim(),
    { do: 'run', command: `mt-publish check ${o.project}`, title: 'Ask whether the project can publish', store: 'check' },
    ...(o.committer === 'publish' ? ([{ do: 'run', command: `mt-publish publish ${o.project} {{promptId}} ${'0'.repeat(40)} "Make the small change"`, title: 'Publish the tested commit', store: 'publish' }] as Action[]) : []),
    handoff('deployer', 'The commit is published; please deploy it.'),
    say('committer', 'published the commit.'),
  ];
}

function last(slug: string): Action[] {
  return [
    claim(),
    { do: 'mcp', tool: 'tasks.complete', args: { taskId: '{{promptId}}' }, title: 'Complete the card' },
    { do: 'mcp', tool: 'messages.post', args: { text: `${slug}: the card is done.` }, title: 'Say it is done' },
    say(slug, 'finished.'),
  ];
}

/** The script of one bot of the chain, by its slug. */
export function chainScript(slug: string, options: ChainOptions = {}): FakeScript {
  const o: Required<ChainOptions> = { branch: 'chain-demo', project: 'starter', committer: 'publish', ...options };
  const entry = CHAIN.find((c) => c.slug === slug);
  if (!entry) throw new Error(`no chain script for “${slug}” (the chain is ${CHAIN.map((c) => c.slug).join(', ')})`);
  const work: Action[] =
    slug === 'engineer'
      ? engineer(o)
      : slug === 'coder'
        ? coder()
        : slug === 'committer'
          ? committer(o)
          : entry.next === null
            ? last(slug)
            : reviewer(slug, entry.next, slug === 'plan-reviewer' ? 'Plan review' : slug === 'code-reviewer' ? 'Code review' : slug === 'tester' ? 'Tests' : 'Deploy');
  return { flavor: 'claude', scenarios: { work }, default: 'work' };
}

/** Writes `<slug>.json` for every bot of the chain into `dir`; returns the file of each slug. */
export function writeChainScripts(dir: string, options: ChainOptions = {}): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const { slug } of CHAIN) {
    files[slug] = join(dir, `${slug}.json`);
    writeFileSync(files[slug], `${JSON.stringify(chainScript(slug, options), null, 2)}\n`);
  }
  return files;
}
