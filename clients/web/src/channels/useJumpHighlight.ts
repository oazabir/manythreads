import { useEffect, useRef, useState, type RefObject } from 'react';

/*
 * Opening a thread or a chat at one message (P36-08: a bookmarked reply, a bookmarked message in a chat with a bot): the list draws its rows a moment after
 * it opens (the thread loads, a run card settles), so the row is looked for every 150 ms, as `ApprovalInThread.tsx` waits for its card. A row that is on an
 * older page is reached by loading the older pages one after the other (the list's own loader, as the channel view does for `?message=`) until it is drawn
 * or there is no older page. Once drawn it is scrolled to the middle of the list and highlighted for a moment, like the channel view's flash. A row that
 * never comes (a message deleted since) leaves the list where it is, a few seconds after the last page.
 */

export const JUMP_FIND_MS = 4000;
export const JUMP_STEP_MS = 150;
/** How long the row stays highlighted (the channel view's flash). */
export const JUMP_HOLD_MS = 2500;

/** The row of a message in a list: every message row carries `data-message-id`. */
export const rowOf = (box: ParentNode, id: string): HTMLElement | null => box.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);

/** The list's older pages: whether there is one, and the loader that adds it (it may be called while one is on its way: the list ignores it). */
export type OlderPages = { more: boolean; loading: boolean; load: () => void };

/**
 * Looks for the row of `target` inside `box` while `ready`, loading older pages while it is not drawn, then scrolls it into view and answers its id while
 * it is highlighted (null otherwise). `onFound` runs just before the scroll: a list that keeps itself at its newest message lets go of the bottom there (its
 * own scroll handler takes it back when the reader returns to the bottom).
 */
export function useJumpHighlight(box: RefObject<HTMLElement | null>, target: string | null, ready: boolean, onFound?: () => void, older?: OlderPages): string | null {
  const [shown, setShown] = useState<string | null>(null);
  // the latest of what the caller passes, read by the wait without starting it again
  const latest = useRef({ onFound, older });
  latest.current = { onFound, older };
  useEffect(() => {
    setShown(null);
    if (!target || !ready) return;
    let since = Date.now();
    let hold: ReturnType<typeof setTimeout> | null = null;
    // the state of the older pages a load was last asked from: the list draws a new one when it starts loading and when the page is in, so one ask per page
    let askedFrom: OlderPages | undefined;
    const look = (): boolean => {
      const el = box.current ? rowOf(box.current, target) : null;
      if (el) {
        latest.current.onFound?.();
        el.scrollIntoView({ block: 'center' });
        setShown(target);
        hold = setTimeout(() => setShown(null), JUMP_HOLD_MS);
        return true;
      }
      const o = latest.current.older;
      if (o?.more) {
        // an older page may hold it: the deadline counts from the last page asked for
        if (!o.loading && o !== askedFrom) {
          askedFrom = o;
          o.load();
        }
        since = Date.now();
        return false;
      }
      if (o?.loading) since = Date.now();
      return false;
    };
    if (look()) return () => void (hold && clearTimeout(hold));
    const timer = setInterval(() => {
      if (look() || Date.now() - since > JUMP_FIND_MS) clearInterval(timer);
    }, JUMP_STEP_MS);
    return () => {
      clearInterval(timer);
      if (hold) clearTimeout(hold);
    };
  }, [box, target, ready]);
  return shown;
}
