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

/*
 * The bell's two counts (P21-10). Most notifications are addressed to the person: a mention, a reply in a thread they follow, a direct message,
 * a reminder they set. Those make the red count. The one kind that is only background news is `message` (any message in a channel they asked to
 * hear everything from): it shows as a grey dot and never raises the number.
 */
export type NotifyKind = InboxItem['kind'];
export const isActivityKind = (kind: NotifyKind): boolean => kind === 'message';

/** What the store remembers of each unread row: enough to split the count and to colour a channel's badge. */
export type UnreadRow = { kind: NotifyKind; channelId: string };

/**
 * Splits the server's unread total in two. `activity` is how many known unread rows are background news; `attention` is the rest of the
 * total (a row the store has not seen yet counts as addressed to the person, which is the safer reading). Never negative.
 */
export function splitUnread(total: number, rows: Iterable<UnreadRow>): { attention: number; activity: number } {
  let activity = 0;
  for (const r of rows) if (isActivityKind(r.kind)) activity += 1;
  activity = Math.min(activity, Math.max(0, total));
  return { attention: Math.max(0, total - activity), activity };
}

/** The channels (and direct messages) that hold an unread mention of the person, for the red badge in Jump to. */
export function mentionedChannelIds(rows: Iterable<UnreadRow>): string[] {
  const out = new Set<string>();
  for (const r of rows) if (r.kind === 'mention') out.add(r.channelId);
  return [...out];
}
