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
