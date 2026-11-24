import type { SavedBookmark, SavedBookmarkItem, SavedBookmarkTab, SavedFileItem } from '@manythreads/shared';
import type { MessageTarget } from '../shell/messageLink';
import { fileSize } from '../channels/format';
import { PERSONAL, spaceHref } from '../screens/files/spaces';

/*
 * What the Bookmarks page shows and where a row leads (P36-08): pure, so the rules are tested without a browser.
 */

export const BOOKMARK_TABS: readonly { id: SavedBookmarkTab; label: string }[] = [
  { id: 'thread', label: 'Threads' },
  { id: 'message', label: 'Messages' },
  { id: 'file', label: 'Files' },
];

export type BookmarkTabId = SavedBookmarkTab;

/** `?tab=` of the page; anything else is the first tab. */
export const tabFrom = (value: string | null): BookmarkTabId => (value === 'message' || value === 'file' ? value : 'thread');

export const EMPTY_TEXT: Record<BookmarkTabId, { title: string; body: string }> = {
  thread: { title: 'No bookmarked threads', body: 'Use the bookmark at the top right of a thread.' },
  message: { title: 'No bookmarked messages', body: 'Use Bookmark in a message’s More menu.' },
  file: { title: 'No bookmarked files', body: 'Use Bookmark in a file’s menu in Files.' },
};

/** The list's name for screen readers, per tab. */
export const LIST_LABEL: Record<BookmarkTabId, string> = { thread: 'Bookmarked threads', message: 'Bookmarked messages', file: 'Bookmarked files' };

/**
 * Where an item lives, in words: "# dev", "Thread in # dev", "Direct message", "Conversation with Brain" (the server names the bot when the caller can read
 * it), else "Conversation with a bot"; a file: "Personal", "Engineering files", "# dev".
 */
export function placeOf(item: SavedBookmarkItem): string {
  if (item.kind === 'file') return filePlaceOf(item);
  const c = item.channel;
  const reply = item.kind === 'message' && item.threadRootId !== null;
  if (c.kind === 'channel') return reply ? `Thread in # ${c.name}` : `# ${c.name}`;
  if (c.kind === 'dm') return reply ? 'Thread in a direct message' : 'Direct message';
  if (c.kind === 'bot_conversation') return c.botName ? `Conversation with ${c.botName}` : 'Conversation with a bot';
  return reply ? 'Thread in a meeting' : 'Meeting';
}

/** Where a bookmarked file lives, in words. */
export function filePlaceOf(item: SavedFileItem): string {
  if (item.store === 'personal') return 'Personal';
  if (item.store === 'repo') return item.team ? `${item.team.name} files` : 'Team files';
  const c = item.channel;
  if (c?.kind === 'channel') return `# ${c.name}`;
  if (c?.kind === 'dm') return 'Direct message';
  if (c?.kind === 'bot_conversation') return 'Conversation with a bot';
  if (c?.kind === 'meeting') return 'Meeting';
  return item.team ? `${item.team.name} files` : 'Files';
}

/** Whether a removal can be undone: the item must be one the server would bookmark again (readable, and a repository file still at its path). */
export const canUndoRemoval = (b: SavedBookmark): boolean => b.item !== null && !(b.item.kind === 'file' && b.item.missing);

/** The line under a file's name: its size, or that it is no longer there. */
export const fileMetaOf = (item: SavedFileItem): string => (item.missing ? 'No longer there' : item.size === null ? '' : fileSize(item.size));

/**
 * Where a click on a bookmark goes: a message or a thread (through `useOpenMessage`), an address (a repository file in its team's Files, a Personal file in
 * Personal), or the right panel on the page itself (an attachment, `file:<id>`, which opens beside the list). A file no longer there still opens: the
 * viewer says so.
 */
export type BookmarkOpen = { type: 'message'; target: MessageTarget } | { type: 'href'; to: string } | { type: 'panel'; entry: { type: 'file'; id: string } };

export function openOf(b: SavedBookmark): BookmarkOpen | null {
  const item = b.item;
  if (item?.kind === 'file') {
    if (b.target.kind === 'repo_file') return item.team ? { type: 'href', to: spaceHref(item.team.slug, { open: b.target.path }) } : null;
    if (b.target.kind !== 'file') return null;
    if (item.store === 'personal') return item.path ? { type: 'href', to: spaceHref(PERSONAL, { open: item.path }) } : null;
    return { type: 'panel', entry: { type: 'file', id: b.target.fileId } };
  }
  const to = openTargetOf(b);
  return to ? { type: 'message', target: to } : null;
}

/**
 * Where a click on a bookmark goes (through `useOpenMessage`): a thread opens its channel (or direct message) with the thread on the right; a channel
 * message opens the channel scrolled to it; a thread reply opens the channel with its thread on the right. A conversation with a bot opens that
 * conversation with the thread. An item the person can no longer read goes nowhere.
 */
export function openTargetOf(b: SavedBookmark): MessageTarget | null {
  const item = b.item;
  if (!item || item.kind === 'file') return null;
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
