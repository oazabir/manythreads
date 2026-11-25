import { useEffect } from 'react';
import { NavLink } from 'react-router';
import { useShell } from '../shell/context';
import { BookmarksNavIcon } from '../shell/icons';
import { GUEST_SLUG } from '../shell/messageLink';
import { bookmarksStore, useBookmarksSupported } from './store';

/**
 * The Bookmarks button of the header, just left of the bell (owner, 2026-11-25): one click opens the person's Bookmarks page. It is always drawn (the page has
 * its own empty state), also for a guest (whose team in the address is the shared one), and it reads as the current page while that page is open. A server
 * without the bookmarks plugin draws nothing, as the bell does when it has nothing to show.
 */
export function BookmarksLink() {
  const { team, teamSlug, guest } = useShell();
  const supported = useBookmarksSupported();
  useEffect(() => {
    void bookmarksStore.load();
  }, []);
  const slug = team?.slug ?? (guest ? (teamSlug ?? GUEST_SLUG) : null);
  if (!supported || !slug) return null;
  return (
    <NavLink to={`/t/${slug}/bookmarks`} className="icon-btn bookmarks-btn" aria-label="Bookmarks" title="Bookmarks" data-testid="header-bookmarks">
      <BookmarksNavIcon />
    </NavLink>
  );
}
