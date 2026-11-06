import type { ThreadInboxItem } from '@manythreads/shared';

/*
 * The words and small rules of a row in the Threads list. Pure, so they are tested without a browser.
 */

/** The place a thread lives, as the row's badge says it. */
export function channelLabel(channel: Pick<ThreadInboxItem['channel'], 'kind' | 'name'>): string {
  if (channel.kind === 'dm') return 'Direct message';
  if (channel.kind === 'bot_conversation') return 'Conversation with a bot';
  return channel.name.replace(/^#/, '');
}

/** The line under the text: "3 new replies" when something is unread, else "98 replies". */
export function repliesLine(item: Pick<ThreadInboxItem, 'replyCount' | 'unreadCount'>): string {
  const n = item.unreadCount > 0 ? Math.min(item.unreadCount, item.replyCount) || item.unreadCount : item.replyCount;
  return `${n} ${item.unreadCount > 0 ? 'new ' : ''}${n === 1 ? 'reply' : 'replies'}`;
}

/** What the row's marker says to a screen reader: the number of unread replies that tag the reader, or that there is something new. */
export function markerLabel(item: Pick<ThreadInboxItem, 'unreadCount' | 'mentionCount'>): string | null {
  if (item.mentionCount > 0) return `${item.mentionCount} unread ${item.mentionCount === 1 ? 'reply names' : 'replies name'} you`;
  if (item.unreadCount > 0) return 'Unread replies';
  return null;
}

/** The thread's text cut into plain pieces and `@handle` pieces, so the handles can be drawn in colour. A handle is at most 64 letters, digits, dots, dashes and underscores. */
export function withHandles(text: string): ReadonlyArray<{ text: string; handle: boolean }> {
  const out: { text: string; handle: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/(?<![\w@])@[\w.-]{1,64}/g)) {
    // a full stop that ends the sentence is not part of the handle
    const handle = m[0].replace(/[.-]+$/, '');
    if (m.index > last) out.push({ text: text.slice(last, m.index), handle: false });
    out.push({ text: handle, handle: true });
    last = m.index + handle.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), handle: false });
  return out;
}

/** The label of the follow entry in the Actions menu, with the sentence under it. */
export const followEntry = (followed: boolean): { label: string; hint: string } =>
  followed ? { label: 'Unfollow thread', hint: 'You won’t be notified about replies' } : { label: 'Follow thread', hint: 'You will be notified about replies' };

export type ThreadDay = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Which day group a thread belongs to, by its newest reply on the reader's clock. */
export function dayOf(iso: string, now: Date): ThreadDay {
  const days = Math.round((dayStart(now) - dayStart(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return days < 7 ? 'This week' : 'Earlier';
}

/** The list cut into day groups, keeping the order it came in (newest first); an empty group is left out. */
export function groupThreads<T extends Pick<ThreadInboxItem, 'lastReplyAt'>>(items: readonly T[], now: Date): ReadonlyArray<{ day: ThreadDay; items: T[] }> {
  const out: Array<{ day: ThreadDay; items: T[] }> = [];
  for (const it of items) {
    const day = dayOf(it.lastReplyAt, now);
    const last = out.at(-1);
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}

/** The newest reply as the row shows it: "Name: preview"; null when none is left to show. */
export const replySnippet = (item: Pick<ThreadInboxItem, 'lastReply'>): string | null =>
  item.lastReply && item.lastReply.preview.trim() ? `${item.lastReply.authorName}: ${item.lastReply.preview.trim()}` : null;
