import type { ThreadTodo, TodoItem, TodoStatus } from '@manythreads/shared';

/*
 * The words of the to-do card (PLAN P25-11, docs/plans/acp.md section 5.3). Pure, so the plain-language rules are tested. The list is the bot's own (a person cannot tick it):
 * the card only reads it, and a screen reader hears each item's status in words, never as an icon alone.
 */

export interface TodoProgress {
  done: number;
  total: number;
  /** Every item is done (and there is at least one). */
  allDone: boolean;
  blocked: number;
  working: number;
}

export function todoProgress(items: readonly Pick<TodoItem, 'status'>[]): TodoProgress {
  const done = items.filter((i) => i.status === 'done').length;
  return {
    done,
    total: items.length,
    allDone: items.length > 0 && done === items.length,
    blocked: items.filter((i) => i.status === 'blocked').length,
    working: items.filter((i) => i.status === 'working').length,
  };
}

/** "3 of 5", or "All done". */
export function progressText(p: TodoProgress): string {
  return p.allDone ? 'All done' : `${p.done} of ${p.total}`;
}

export const STATUS_WORD: Record<TodoStatus, string> = {
  waiting: 'To do',
  working: 'Working on it',
  done: 'Done',
  blocked: 'Blocked',
};

/** The title, or a plain one when the bot gave none. */
export const todoTitle = (todo: Pick<ThreadTodo, 'title'>): string => (todo.title.trim() !== '' ? todo.title.trim() : 'To do');

/** The item to show on the one-line bar: the one being worked on, else a blocked one, else the next to do. Null when all are done. */
export function currentItem(items: readonly TodoItem[]): TodoItem | null {
  return items.find((i) => i.status === 'working') ?? items.find((i) => i.status === 'blocked') ?? items.find((i) => i.status === 'waiting') ?? null;
}

/** Whether the sticky bar shows: while something is open. A finished list stays in the thread as its card, and does not pin. */
export const isOpen = (items: readonly Pick<TodoItem, 'status'>[]): boolean => items.length > 0 && items.some((i) => i.status !== 'done');

/**
 * The bar's line: "Coder is working on Write the e2e test" (or "Working on ..." when the owner is not known), "Blocked: ..." when something waits on a person or a card, "Next: ..."
 * when nothing is being worked on. `ownerName` names the holder of an item's card.
 */
export function barLine(todo: ThreadTodo, ownerName: (actorId: string) => string | undefined = () => undefined): { text: string; progress: string; tone: 'working' | 'blocked' | 'waiting' | 'done' } {
  const p = todoProgress(todo.items);
  const cur = currentItem(todo.items);
  if (cur === null) return { text: todoTitle(todo), progress: progressText(p), tone: 'done' };
  const owner = cur.ownerId !== undefined ? ownerName(cur.ownerId) : undefined;
  const text = cur.status === 'working' ? (owner !== undefined ? `${owner} is working on ${cur.text}` : `Working on ${cur.text}`) : cur.status === 'blocked' ? `Blocked: ${cur.text}` : `Next: ${cur.text}`;
  return { text, progress: progressText(p), tone: cur.status === 'done' ? 'done' : cur.status };
}

/** How many finished items a long list folds into one "12 done" line: none on a short list, where every item reads at a glance. */
export function foldDone(items: readonly Pick<TodoItem, 'status'>[], longFrom = 9, atLeast = 3): number {
  const done = items.filter((i) => i.status === 'done').length;
  return items.length >= longFrom && done >= atLeast ? done : 0;
}
