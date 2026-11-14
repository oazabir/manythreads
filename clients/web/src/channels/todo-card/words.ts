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

/** The bar's line: "Write the e2e test · 3 of 5", or "Blocked: ..." when something waits on a person or a card. */
export function barLine(todo: ThreadTodo): { text: string; progress: string; tone: 'working' | 'blocked' | 'waiting' | 'done' } {
  const p = todoProgress(todo.items);
  const cur = currentItem(todo.items);
  return { text: cur !== null ? cur.text : todoTitle(todo), progress: progressText(p), tone: cur === null ? 'done' : cur.status === 'done' ? 'done' : cur.status };
}
