import { ApiError } from '../../api/client';
import { BOT_TEST_QUESTION_MAX, type BotTestResult, type BotTestStatus, type RehearsalIntercept } from '@manythreads/shared';

/*
 * The logic of the bot page's Test panel (PLAN P7-11), kept apart from the screen so it can be tested without one: what may be sent, how a refusal
 * reads, what each held-back write is called in plain words, and when to stop asking. Nothing here decides whether a write is held back: the server's
 * broker does, from the run's own record.
 */

export const QUESTION_MAX = BOT_TEST_QUESTION_MAX;
/** How often the panel asks how the test stands, and how long it waits before it says the bot is taking long. */
export const POLL_MS = 2000;
export const GIVE_UP_MS = 180_000;

/** Why this question cannot be sent yet, in a sentence; null when it can. */
export function questionProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Type a question first.';
  if (t.length > QUESTION_MAX) return `Keep it under ${QUESTION_MAX} characters (it is ${t.length}).`;
  return null;
}

/** What a tool the broker held back is called to a person. A tool this list does not know keeps its own name: it is shown, never hidden. */
const LABELS: Record<string, string> = {
  'messages.post': 'Post a message',
  'messages.update': 'Edit a message',
  'pages.write': 'Write a page',
  'proposals.propose': 'Propose a change to a file',
  'memory.retain': 'Remember something',
  'memory.write': 'Write to memory',
  'tasks.create': 'Create a task',
  'tasks.claim': 'Take a task',
  'tasks.complete': 'Finish a task',
  'tasks.release': 'Give a task back',
  'tasks.describe': 'Change a task description',
  'tasks.deploy': 'Deploy',
  'tasks.pull_request': 'Open a pull request',
  'tasks.handoff': 'Hand a task to another bot',
  'tasks.private_note': 'Leave a private note on a task',
  'boards.ensure': 'Create a board',
};

export const capabilityLabel = (capability: string): string => LABELS[capability] ?? capability;

/** One line for the "not done" list: the plain label, the tool's own name, what it aimed at, and whether a real call would have waited for a person. */
export function interceptLine(i: Pick<RehearsalIntercept, 'capability' | 'target' | 'wouldWait'>): { label: string; tool: string; target: string | null; wait: string | null } {
  return {
    label: capabilityLabel(i.capability),
    tool: i.capability,
    target: i.target,
    wait: i.wouldWait ? 'A real call would have waited in the Approvals inbox.' : null,
  };
}

/** The sentence under the answer about the knowledge behind it; null when there is nothing to add. */
export function knowledgeNote(k: BotTestResult['knowledge']): string | null {
  if (k === 'none') return 'This bot has no knowledge base with documents yet, so it answered from what it has. Add documents on the Knowledge tab to give it sources to cite.';
  if (k === 'not_used') return 'The bot did not look anything up in its knowledge bases for this question.';
  return null;
}

/** Has the test reached an end the panel can show (no more asking)? */
export const isFinished = (s: BotTestStatus): boolean => s !== 'waiting';

export function statusNote(s: BotTestStatus): string | null {
  if (s === 'stopped') return 'The test ended without an answer. The bot may have been held for a person, refused a check, or have nothing to say to this question.';
  if (s === 'failed') return 'The bot could not finish this run. Open the Audit tab to see what went wrong.';
  return null;
}

/** The sentence for a question the server refused or could not take. */
export function startFailureText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'You are asking too fast. Wait a moment and try again.';
    if (err.status === 403) return 'Only a team lead or a workspace admin can test this bot.';
    return err.message;
  }
  return 'The test could not be started. Try again.';
}

/** Has the panel waited long enough to say so? */
export const tookTooLong = (startedAt: number, now: number): boolean => now - startedAt >= GIVE_UP_MS;

/** Is the Test button offered at all: someone who may manage the bot, on a bot that answers conversations. The server decides again. */
export const canOfferTest = (b: { canEdit: boolean; status: string; conversational: boolean; runtime: string }): boolean =>
  b.canEdit && b.status === 'active' && b.conversational && b.runtime === 'hermes';
