import { ApiError } from '../../api/client';
import type { BotDeployOutcome, BotDeployRequest, BotDeployResponse, BotDeployState, BotDeployStep } from '@manythreads/shared';

/*
 * The logic of the bot page's Deploy action (PLAN P8-34), kept apart from the screen so it can be tested without one: what is sent, what each of the three outcomes is called in
 * plain words, and how a refusal reads. Nothing here decides whether a deploy may happen: the server runs every check, and a deploy is never a state of the bot.
 */

/** What each part is called to a person, in the order the server reports them. */
export const STEP_TITLE: Record<BotDeployStep, string> = {
  definition: 'Definition',
  knowledge: 'Knowledge',
  connection: 'Connection',
};

const STATE_LABEL: Record<BotDeployState, string> = {
  changed: 'Done',
  unchanged: 'Already as needed',
  not_used: 'Not used',
  refused: 'Refused',
  not_run: 'Not attempted',
};

export const stateLabel = (state: BotDeployState): string => STATE_LABEL[state];

/** `refused` is the only state that needs the person to do something; `not_run` follows a refusal and is shown quietly. */
export const needsAttention = (o: Pick<BotDeployOutcome, 'state'>): boolean => o.state === 'refused';

/**
 * What to send. A definition with unsaved changes is committed first (the text on the page, from the blob the page loaded); a definition without any is deployed as the repo holds it,
 * which sends nothing at all. A draft that does not pass the page's own checks is not sent.
 */
export function deployBody(draft: { dirty: boolean; issues: readonly unknown[]; text: () => string; baseBlobSha: string | null }): BotDeployRequest | null {
  if (!draft.dirty) return {};
  if (draft.issues.length > 0) return null;
  return { content: draft.text(), baseBlobSha: draft.baseBlobSha };
}

/** Why the Deploy button waits, in a sentence; null when it can be pressed. */
export function deployProblem(b: { status: string; busy: boolean; issues: number }): string | null {
  if (b.busy) return 'A deploy is running.';
  if (b.status !== 'active') return 'Only an active bot can be deployed.';
  if (b.issues > 0) return 'Fix what the page lists under the tabs first; a definition that does not pass cannot be deployed.';
  return null;
}

/** The headline over the three outcomes, from what the server answered. */
export function headline(r: Pick<BotDeployResponse, 'deployed' | 'summary' | 'outcomes'>): { tone: 'ok' | 'same' | 'bad'; text: string } {
  if (r.outcomes.some(needsAttention)) return { tone: 'bad', text: r.summary };
  return r.deployed ? { tone: 'ok', text: r.summary } : { tone: 'same', text: r.summary };
}

/** A request that failed as a whole (not a refusal of one part: those come back as outcomes). */
export function deployFailureText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'You are deploying too fast. Wait a moment and try again.';
    if (err.status === 403) return 'Only a team lead or a workspace admin can deploy this bot.';
    return err.message;
  }
  return 'The deploy could not be started. Try again.';
}
