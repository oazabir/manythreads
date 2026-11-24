import type { BookmarkTarget, MessageId } from '@manythreads/shared';
import { sayToast } from '../kernel/toast';
import { bookmarkErrorText, bookmarksStore } from './store';

/*
 * The one way every bookmark control writes (P36-08): the thread pane's toggle, a thread card's menu and a message's More menu all call these, so the words
 * are the same everywhere. The toast says what actually happened: "Thread bookmarked" / "Message bookmarked", "Bookmark removed", the server's own words
 * when it refused, and nothing for a press that was ignored because the last one is still on its way.
 */

/** The toast after a toggle of `kind` that left it `on`. */
export const bookmarkToastText = (kind: BookmarkTarget['kind'], on: boolean): string =>
  on ? (kind === 'thread' ? 'Thread bookmarked' : kind === 'message' ? 'Message bookmarked' : 'File bookmarked') : 'Bookmark removed';

export async function toggleBookmark(target: BookmarkTarget): Promise<void> {
  try {
    const done = await bookmarksStore.toggle(target);
    if (!done.ignored) sayToast(bookmarkToastText(target.kind, done.on), { testId: 'bookmark-toast' });
  } catch (e) {
    sayToast(bookmarkErrorText(e), { testId: 'bookmark-toast' });
  }
}

export const toggleThreadBookmark = (rootMessageId: string): Promise<void> => toggleBookmark({ kind: 'thread', rootMessageId: rootMessageId as MessageId });
export const toggleMessageBookmark = (messageId: string): Promise<void> => toggleBookmark({ kind: 'message', messageId: messageId as MessageId });
