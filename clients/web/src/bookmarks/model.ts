import type { SavedBookmark, SavedBookmarkItem, SavedBookmarkTab } from '@manythreads/shared';
import type { MessageTarget } from '../shell/messageLink';

/*
 * What the Bookmarks page shows and where a row leads (P36-08): pure, so the rules are tested without a browser.
 */

export const BOOKMARK_TABS: readonly { id: Exclude<SavedBookmarkTab, 'file'>; label: string }[] = [
  { id: 'thread', label: 'Threads' },
  { id: 'message', label: 'Messages' },
];

export type BookmarkTabId = (typeof BOOKMARK_TABS)[number]['id'];

/** `?tab=` of the page; anything else is the first tab. */
export const tabFrom = (value: string | null): BookmarkTabId => (value === 'message' ? 'message' : 'thread');

export const EMPTY_TEXT: Record<BookmarkTabId, { title: string; body: string }> = {
  thread: { title: 'No bookmarked threads', body: 'Use the bookmark at the top right of a thread.' },
  message: { title: 'No bookmarked messages', body: 'Use Bookmark in a message’s More menu.' },
};

/** Where an item lives, in words: "# dev", "Thread in # dev", "Direct message", "Conversation with a bot". */
export function placeOf(item: SavedBookmarkItem): string {
  const c = item.channel;
  const reply = item.kind === 'message' && item.threadRootId !== null;
  if (c.kind === 'channel') return reply ? `Thread in # ${c.name}` : `# ${c.name}`;
  if (c.kind === 'dm') return reply ? 'Thread in a direct message' : 'Direct message';
  if (c.kind === 'bot_conversation') return 'Conversation with a bot';
  return reply ? 'Thread in a meeting' : 'Meeting';
}

/**
 * Where a click on a bookmark goes (through `useOpenMessage`): a thread opens its channel (or direct message) with the thread on the right; a channel
 * message opens the channel scrolled to it; a thread reply opens the channel with its thread on the right. A conversation with a bot opens that
 * conversation with the thread. An item the person can no longer read goes nowhere.
 */
export function openTargetOf(b: SavedBookmark): MessageTarget | null {
  const item = b.item;
  if (!item) return null;
  const place = { channelId: item.channel.id, channelKind: item.channel.kind, channelName: item.channel.kind === 'channel' ? item.channel.name : null, teamId: item.channel.teamId };
  if (item.kind === 'thread' && b.target.kind === 'thread') return { ...place, messageId: b.target.rootMessageId, threadRootId: b.target.rootMessageId };
  if (item.kind === 'message' && b.target.kind === 'message') return { ...place, messageId: b.target.messageId, threadRootId: item.threadRootId };
  return null;
}

/** "3 replies" / "1 reply" / "No replies yet". */
export const repliesText = (n: number): string => (n === 0 ? 'No replies yet' : n === 1 ? '1 reply' : `${String(n)} replies`);

/** A short time: the clock today, the day and month before. */
export function shortWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * The rows the page shows: the pages read so far in order, without the bookmarks removed here (`gone`), with a bookmark brought back by Undo shown in its
 * old place under its new id (`swap`: old id to the new bookmark), each bookmark once.
 */
export function shownBookmarks(pages: readonly (readonly SavedBookmark[])[], gone: { has(id: string): boolean }, swap: ReadonlyMap<string, SavedBookmark>): SavedBookmark[] {
  const seen = new Set<string>();
  const out: SavedBookmark[] = [];
  for (const page of pages) {
    for (const b of page) {
      if (gone.has(b.id)) continue;
      const shown = swap.get(b.id) ?? b;
      if (gone.has(shown.id) || seen.has(shown.id)) continue;
      seen.add(shown.id);
      out.push(shown);
    }
  }
  return out;
}

/** A removal made on the page: when the server confirmed it (null while it is on its way). */
export type PageRemoval = { confirmedAt: number | null };

/**
 * A tab's count: the server's (from the answer asked for at `answerAt`), less the removals made here that this count still holds: one still on its way, or one
 * the server confirmed after that answer was asked for. A removal the server had already confirmed when the answer was asked for is in neither the answer's
 * count nor taken off again, wherever its row is.
 */
export function shownCount(
  server: number,
  answerAt: number,
  pages: readonly (readonly SavedBookmark[])[],
  gone: ReadonlyMap<string, PageRemoval>,
  swap: ReadonlyMap<string, SavedBookmark> = new Map(),
): number {
  const held = new Set<string>();
  for (const page of pages) {
    for (const b of page) {
      // a row brought back by Undo stands for its new bookmark
      const r = gone.get(b.id) ?? gone.get(swap.get(b.id)?.id ?? '');
      if (r && (r.confirmedAt === null || r.confirmedAt >= answerAt)) held.add(b.id);
    }
  }
  return Math.max(0, server - held.size);
}
