import {
  WORKSHOP_MAX_MESSAGES,
  WORKSHOP_MESSAGE_MAX,
  type WorkshopEntry,
  type WorkshopMode,
  type WorkshopProposalRole,
  type WorkshopSession,
  type WorkshopStepOutcome,
  type WorkshopUsage,
} from '@manythreads/shared';

/*
 * The Workshop tab's words and small rules (PLAN P7-05, P7-06). Pure, so they are tested without a browser. Every sentence a person reads is here or in the parts, in plain words.
 */

export type ModeInfo = { id: WorkshopMode; label: string; lead: string; hint: string; placeholder: string; start: string };

export const MODES: readonly ModeInfo[] = [
  {
    id: 'build',
    label: 'Build',
    lead: 'Ask for a change to this bot. It writes the change as a proposal, a before and after that waits until a person approves it.',
    hint: 'Nothing changes until someone approves. When you correct the bot, the helper proposes a lesson for it to remember and a test case that checks it.',
    placeholder: 'What should change? Or tell it what the bot got wrong.',
    start: 'Start a Build conversation',
  },
  {
    id: 'rehearse',
    label: 'Rehearse',
    lead: 'Try the bot as it really is: its own instructions, its notes and the tools that only read. Anything that would change something is held back.',
    hint: 'Held-back actions are marked “not really done”. Nothing leaves this tab: no message is posted and nothing is saved.',
    placeholder: 'Say something to the bot, as a teammate would.',
    start: 'Start a rehearsal',
  },
  {
    id: 'live',
    label: 'Live',
    lead: 'Ask about what this bot really did. The answers come from its past runs, and only the runs you are allowed to see.',
    hint: 'Read only. It cannot change the bot or anything else.',
    placeholder: 'Ask about its recent work, for example: what went wrong this week?',
    start: 'Start a Live conversation',
  },
];

export const modeInfo = (mode: WorkshopMode): ModeInfo => MODES.find((m) => m.id === mode) ?? (MODES[0] as ModeInfo);

/** What a held or finished tool call is called in the step lines. */
export const OUTCOME_WORDS: Record<WorkshopStepOutcome, string> = {
  read: 'Looked, changed nothing',
  held: 'Held back',
  refused: 'Not allowed',
  failed: 'Did not work',
  ok: 'Done',
};

/** What a filed proposal is for, in plain words. */
export const PROPOSAL_ROLE_WORDS: Record<WorkshopProposalRole, string> = {
  bot: 'A change to the bot',
  lessons: 'A lesson to remember',
  eval: 'A test case for that lesson',
  rule: 'A rule for the bot',
  compaction: 'A shorter list of lessons',
  evals_block: 'Where the test cases are listed',
};

export const textReady = (text: string): boolean => text.trim().length > 0 && text.length <= WORKSHOP_MESSAGE_MAX;
export const charsLeft = (text: string): number => WORKSHOP_MESSAGE_MAX - text.length;

/** The start of a message that asks the helper to turn the lesson into a rule. The server reads the person's own words for it. */
export const RULE_PREFIX = 'Make that a rule: ';
export const asRule = (text: string): string => (text.startsWith(RULE_PREFIX) ? text : `${RULE_PREFIX}${text.trim()}`).slice(0, WORKSHOP_MESSAGE_MAX);

/** The line under a conversation that says what it has cost. A rehearsal is labelled so: the Spend page shows its calls as a row of their own, “Rehearsal of <bot>”, and the bot’s budget counts them. */
export function usageLine(usage: WorkshopUsage): string {
  if (usage.calls === 0) return '';
  const tokens = usage.promptTokens + usage.completionTokens;
  const calls = `${String(usage.calls)} model ${usage.calls === 1 ? 'call' : 'calls'}`;
  const words = `${calls}, about ${tokens.toLocaleString('en-US')} tokens`;
  return usage.label === 'rehearsal' ? `Rehearsal spend: ${words}. On the Spend page it is a row of its own, and it counts toward the bot’s budget.` : `Workshop spend: ${words}.`;
}

export const messagesLeft = (session: Pick<WorkshopSession, 'messageCount'>): number => Math.max(0, WORKSHOP_MAX_MESSAGES - session.messageCount);

/** The words a screen reader hears when the conversation changes under it. */
export function announcement(prev: WorkshopSession | null, next: WorkshopSession | null): string {
  if (next === null) return '';
  if (next.status === 'working') return 'Working on it.';
  if (next.status === 'failed') return next.message ?? 'It could not finish.';
  if (next.status === 'ended') return 'This conversation has ended.';
  if (next.status === 'cancelled') return 'Stopped.';
  if (prev === null || prev.status === 'working') {
    const last = [...next.entries].reverse().find((e) => e.kind === 'reply');
    const held = next.entries.filter((e) => e.kind === 'step' && e.outcome === 'held').length;
    const n = next.entries.filter((e) => e.kind === 'proposal').length;
    return `${last ? 'There is an answer.' : 'Ready.'}${held > 0 ? ` ${String(held)} ${held === 1 ? 'action was' : 'actions were'} held back (not really done).` : ''}${n > 0 ? ` ${String(n)} ${n === 1 ? 'proposal is' : 'proposals are'} waiting for approval.` : ''}`;
  }
  return '';
}

/** The newest answer a person can correct: the last reply of a rehearsal. */
export const lastReplyId = (entries: ReadonlyArray<WorkshopEntry>): string | null => [...entries].reverse().find((e) => e.kind === 'reply')?.id ?? null;

/** The tab on a bot's conversation page that is open: `?view=workshop` or the chat. */
export type View = 'chat' | 'workshop';
export const viewOf = (raw: string | null): View => (raw === 'workshop' ? 'workshop' : 'chat');
export const modeOf = (raw: string | null): WorkshopMode => (raw === 'rehearse' || raw === 'live' ? raw : 'build');

/** The next tab for an arrow key in a row of tabs (Left/Right wrap round; Home and End jump to the ends). Null for any other key. */
export function nextTab(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
