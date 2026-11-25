import { useEffect, useRef } from 'react';
import { usePanel } from '../kernel/panel';
import { BookmarksNavIcon } from '../shell/icons';
import { bookmarksEntry, bookmarksOpen, bookmarksPress } from './panelEntry';
import { bookmarksStore, useBookmarksSupported } from './store';
import { useBookmarksSlug } from './useBookmarksSlug';

/**
 * The Bookmarks button of the header, just left of the bell (owner, 2026-11-25): it is a toggle for the right-hand Bookmarks panel (P37-08,
 * bookmarks/BookmarksPanel.tsx). One press shows the panel, the next hides it; while the panel is on screen the button reads as pressed. Focus moves into the
 * panel when the button opened it and back to the button when the panel closes (the button, Close or Esc). It is always drawn (the panel has its own empty
 * state), also for a guest (whose team in the address is the shared one). A server without the bookmarks plugin draws nothing, as the bell does when it has
 * nothing to show. The page `/t/<team>/bookmarks` is still there, as "Open as a page" in the panel.
 */
export function BookmarksLink() {
  const slug = useBookmarksSlug();
  const supported = useBookmarksSupported();
  const panel = usePanel();
  const button = useRef<HTMLButtonElement>(null);
  // set by a press that opened the panel: focus goes into it once it is drawn, and comes back here when it is gone
  const owesFocus = useRef(false);
  const open = bookmarksOpen(panel.entries);
  useEffect(() => {
    void bookmarksStore.load();
  }, []);
  useEffect(() => {
    if (open) {
      if (!owesFocus.current) return;
      // the panel's selected tab (the list's first stop); the panel itself when it has none yet
      const into = document.querySelector<HTMLElement>('[data-testid="bookmarks-panel"] [role="tab"][tabindex="0"]') ?? document.querySelector<HTMLElement>('[data-testid="bookmarks-panel"]');
      into?.focus();
    } else if (owesFocus.current) {
      owesFocus.current = false;
      // the panel's own controls went with it: if nothing else took the focus, it returns to the button
      const at = document.activeElement;
      if (!at || at === document.body) button.current?.focus();
    }
  }, [open]);
  if (!supported || !slug) return null;
  const press = (): void => {
    const what = bookmarksPress(panel.entries);
    if (what === 'open') {
      owesFocus.current = true;
      panel.push(bookmarksEntry());
    } else if (what === 'back') panel.back();
    else panel.close();
  };
  return (
    <button
      type="button"
      ref={button}
      className="icon-btn bookmarks-btn"
      aria-label="Bookmarks"
      title="Bookmarks"
      aria-pressed={open}
      aria-expanded={open}
      data-testid="header-bookmarks"
      onClick={press}
    >
      <BookmarksNavIcon />
    </button>
  );
}
