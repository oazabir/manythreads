import type { ActionItemView } from '@manythreads/shared';

/*
 * The words of the action items view: due dates said the way a person says them, the open items before the finished ones, and the sentences for a list that
 * changed under the reader. Pure functions; the date is passed in so the wording is tested without a clock.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today as `2026-11-20`, in the reader's own calendar. */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const dayNumber = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;

export function dueLabel(due: string, today: string): { text: string; overdue: boolean } {
  const days = dayNumber(due) - dayNumber(today);
  const date = `${Number(due.slice(8, 10))} ${MONTHS[Number(due.slice(5, 7)) - 1] ?? ''}`;
  if (days === 0) return { text: 'Due today', overdue: false };
  if (days === 1) return { text: 'Due tomorrow', overdue: false };
  if (days === -1) return { text: 'Was due yesterday', overdue: true };
  if (days < 0) return { text: `Was due ${date}`, overdue: true };
  return { text: `Due ${date}`, overdue: false };
}

/** Open items first (the order of the file is kept inside each group), then the finished ones. */
export function splitItems(items: readonly ActionItemView[]): { open: ActionItemView[]; done: ActionItemView[] } {
  return { open: items.filter((i) => !i.done), done: items.filter((i) => i.done) };
}

export const countLine = (items: readonly ActionItemView[]): string => {
  const { open, done } = splitItems(items);
  if (items.length === 0) return 'Nothing on your list yet.';
  return `${open.length} to do, ${done.length} done.`;
};

/** A due date typed in a box must be a real calendar day; empty means no date. */
export function dueProblem(value: string): string | null {
  if (value.trim() === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Pick a date.';
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? 'That is not a real date.' : null;
}

/** The sentence after a 409: the list changed while it was open, and the change was not saved. */
export const CHANGED_UNDER_YOU = 'Your list changed while you were looking at it, so I reloaded it. Your change was not saved; please do it again.';

export const isConflict = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 409;
