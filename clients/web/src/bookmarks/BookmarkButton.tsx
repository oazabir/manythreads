import { bookmarkKey, type BookmarkTarget, type MessageId } from '@manythreads/shared';
import { useEffect } from 'react';
import { BookmarkToggleIcon } from '../shell/icons';
import { toggleBookmark } from './actions';
import { bookmarksStore, useBookmarkPending, useBookmarked, useBookmarksReady } from './store';

/*
 * One bookmark icon button (P36-08) for a target that has no menu of its own to hold the item: an answer and the person's own message in a chat with a bot,
 * a file in its viewer and in the right panel. Outline when off, filled when on, `aria-pressed`; waits while its write is on its way; drawn only on a server
 * with bookmarks. The toast and the words come from `actions.ts`, as everywhere else.
 */

export function BookmarkToggle({ target, className, label, testId, size }: { target: BookmarkTarget | null; className: string; label: string; testId: string; size?: number }) {
  const ready = useBookmarksReady();
  // a hook may not be skipped: a row with nothing to bookmark asks for a key no bookmark has
  const kind = target?.kind ?? 'file';
  const key = target ? bookmarkKey(target) : '';
  const on = useBookmarked(kind, key);
  const busy = useBookmarkPending(kind, key);
  useEffect(() => {
    void bookmarksStore.load();
  }, []);
  if (!ready || !target) return null;
  const name = on ? 'Remove bookmark' : label;
  return (
    <button type="button" className={`${className} ${on ? 'on' : ''}`} aria-label={name} title={name} aria-pressed={on} disabled={busy} data-testid={testId} data-on={on} onClick={() => void toggleBookmark(target)}>
      <BookmarkToggleIcon filled={on} {...(size ? { size } : {})} />
    </button>
  );
}

/** The toggle of a message (an answer, or the person's own message, in a chat with a bot). */
export const BookmarkButton = ({ messageId, className, label, testId }: { messageId: string; className: string; label: string; testId: string }) => (
  <BookmarkToggle target={{ kind: 'message', messageId: messageId as MessageId }} className={className} label={label} testId={testId} />
);
