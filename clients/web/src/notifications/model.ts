import type { Notification as InboxItem } from '@manythreads/shared';
import { dayOf, type ThreadDay } from '../screens/threadCard';

export type BellTab = 'unread' | 'all';

/** What the tab shows: Unread keeps what has no read time; All is the whole list. */
export const forTab = (items: readonly InboxItem[], tab: BellTab): InboxItem[] => (tab === 'unread' ? items.filter((n) => n.readAt === null) : [...items]);

/** The list cut into day groups by when each arrived, keeping the order it came in (newest first). */
export function groupByDay(items: readonly InboxItem[], now: Date): ReadonlyArray<{ day: ThreadDay; items: InboxItem[] }> {
  const out: Array<{ day: ThreadDay; items: InboxItem[] }> = [];
  for (const n of items) {
    const day = dayOf(n.createdAt, now);
    const last = out.at(-1);
    if (last && last.day === day) last.items.push(n);
    else out.push({ day, items: [n] });
  }
  return out;
}
