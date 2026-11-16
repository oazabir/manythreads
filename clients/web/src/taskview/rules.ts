import { CHANNEL_TODO_DONE_MINUTES, type RunHead } from '@manythreads/shared';
import { todoProgress } from '../channels/todo-card/words';
import type { TaskViewState } from './channelTasks';

/*
 * What the task view under a root shows, as a pure function of its state, the time and what the person did (P29, docs/plans/channel-task-view.md section 2). Pure so every rule
 * of "when it shows and when it goes" is tested without a screen.
 */

/** A good run leaves its one folded line for this long; a failed or stopped one stays longer (somebody should see it). */
export const ENDED_GOOD_MS = 5 * 60_000;
export const ENDED_BAD_MS = 30 * 60_000;
export const TODO_DONE_MS = CHANNEL_TODO_DONE_MINUTES * 60_000;

export interface TaskPlan {
  /** The to-do card shows: a list with an open item, or one that finished a moment ago. */
  todo: boolean;
  /** `live`: the run card with its steps; `ended`: its one folded line; null: no run card. */
  run: 'live' | 'ended' | null;
  /** The run that ended lately is shown as its folded line. */
  ended: RunHead | null;
  /** The cards are folded to the chip because the root is open in the right panel, or because the person hid them. The questions never fold for "hidden". */
  folded: 'panel' | 'hidden' | null;
  /** The question strip: the pending ones, shown even when hidden, folded away only while the thread itself is open beside the list. */
  questions: TaskViewState['questions'];
  /** At most two cards (to-do and run) at once; true when something besides them is working. */
  moreRuns: number;
  /** Anything at all is drawn (cards or strip). */
  any: boolean;
}

export function endedHeadVisible(head: RunHead, now: number): boolean {
  if (head.endedAt === null) return false;
  const age = now - Date.parse(head.endedAt);
  if (!Number.isFinite(age)) return false;
  // a good run with nothing to say (no steps) leaves no line at all, as in the thread
  const bad = head.state === 'failed' || head.state === 'stopped';
  if (!bad && head.counts.steps === 0 && head.counts.helpers === 0 && head.counts.filesChanged === 0) return false;
  return age < (bad ? ENDED_BAD_MS : ENDED_GOOD_MS);
}

export function todoVisible(todo: TaskViewState['todo'], now: number): boolean {
  if (todo === null || todo.items.length === 0) return false;
  const p = todoProgress(todo.items);
  if (!p.allDone) return true; // the server sends only lists changed in the last day; a list with open items shows
  const age = now - Date.parse(todo.updatedAt);
  return Number.isFinite(age) && age < TODO_DONE_MS;
}

export function planTaskView(view: TaskViewState, now: number, o: { hidden: boolean; openInPanel: boolean }): TaskPlan {
  const todo = todoVisible(view.todo, now);
  const run = view.run !== null ? ('live' as const) : view.ended !== null && endedHeadVisible(view.ended, now) ? ('ended' as const) : null;
  // a root open in the right panel shows everything there (cards and questions): the channel keeps only the chip, so no question is asked twice on one screen
  const folded = o.openInPanel ? ('panel' as const) : o.hidden ? ('hidden' as const) : null;
  const questions = o.openInPanel ? [] : view.questions;
  const cards = folded === null && (todo || run !== null);
  return {
    todo: cards && todo,
    run: cards ? run : null,
    ended: cards && run === 'ended' ? view.ended : null,
    folded: folded !== null && (todo || run !== null) ? folded : null,
    questions,
    moreRuns: cards && run === 'live' ? view.moreRuns : 0,
    any: cards || questions.length > 0,
  };
}
