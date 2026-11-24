import { useEffect } from 'react';
import { BookmarkMarkIcon, BookmarkToggleIcon } from '../shell/icons';
import { toggleMessageBookmark, toggleThreadBookmark } from './actions';
import { bookmarksStore, useBookmarkPending, useBookmarked, useBookmarksReady } from './store';

/*
 * The bookmark part of a message's More menu (P36-08) and the small mark by a bookmarked message's time. A message is bookmarked with "Bookmark"; the first
 * message of a thread offers "Bookmark message" and "Bookmark thread". Every write goes through `actions.ts` (one wording, one toast); each piece listens to
 * its own answer only.
 */

/** The menu entries; `thread` is set for a thread's first message (the thread can be bookmarked from it too). */
export function BookmarkMenuItems({ messageId, thread, close }: { messageId: string; thread: boolean; close: () => void }) {
  const ready = useBookmarksReady();
  const messageOn = useBookmarked('message', messageId);
  const threadOn = useBookmarked('thread', messageId);
  const messageBusy = useBookmarkPending('message', messageId);
  const threadBusy = useBookmarkPending('thread', messageId);
  useEffect(() => {
    void bookmarksStore.load();
  }, []);
  if (!ready) return null;
  return (
    <>
      <button type="button" role="menuitem" className="menu-item" data-testid="message-bookmark" data-on={messageOn} disabled={messageBusy} onClick={() => { close(); void toggleMessageBookmark(messageId); }}>
        <BookmarkToggleIcon filled={messageOn} size={14} /> {thread ? (messageOn ? 'Remove message bookmark' : 'Bookmark message') : messageOn ? 'Remove bookmark' : 'Bookmark'}
      </button>
      {thread ? (
        <button type="button" role="menuitem" className="menu-item" data-testid="message-bookmark-thread" data-on={threadOn} disabled={threadBusy} onClick={() => { close(); void toggleThreadBookmark(messageId); }}>
          <BookmarkToggleIcon filled={threadOn} size={14} /> {threadOn ? 'Remove thread bookmark' : 'Bookmark thread'}
        </button>
      ) : null}
    </>
  );
}

/** "Bookmarked" by the time of a bookmarked message: a small filled bookmark, the word for screen readers only. */
export function BookmarkedMark({ messageId }: { messageId: string }) {
  const on = useBookmarked('message', messageId);
  if (!on) return null;
  return (
    <span className="msg-bookmarked" data-testid="bookmarked-mark" title="Bookmarked">
      <BookmarkMarkIcon />
      <span className="sr-only">Bookmarked</span>
    </span>
  );
}
