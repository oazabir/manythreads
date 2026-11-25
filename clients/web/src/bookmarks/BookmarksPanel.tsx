import { Link, useNavigate } from 'react-router';
import { usePanel, type PanelEntry } from '../kernel/panel';
import { useOpenMessage } from '../shell/messageLink';
import { useNarrow } from '../shell/useNarrow';
import { BookmarksList } from './BookmarksList';
import { type BookmarkOpen, type BookmarkTabId } from './model';
import { bookmarksEntry, bookmarksTabOf, withPanel } from './panelEntry';
import { useBookmarksSupported } from './store';
import { useBookmarksSlug } from './useBookmarksSlug';

/**
 * The right-hand Bookmarks panel (P37-08, owner 2026-11-25): the person's bookmarks beside whatever they are reading, opened and closed by the Bookmarks button at the
 * top right. It is the Bookmarks page's list (bookmarks/BookmarksList.tsx) in a narrow column. A click on a row switches the main view to that item and the panel
 * stays, so the person can go through several. Two things open in the panel itself and so come on top of the list, with Back returning to it: a thread (a bookmarked
 * thread or reply) and an attachment. On a phone the panel is a full sheet, so choosing an item closes it.
 */
export function BookmarksPanel({ entry }: { entry: PanelEntry }) {
  const tab = bookmarksTabOf(entry);
  const panel = usePanel();
  const narrow = useNarrow();
  const navigate = useNavigate();
  const openMessage = useOpenMessage();
  const supported = useBookmarksSupported();
  const slug = useBookmarksSlug();
  const go = (to: BookmarkOpen): void => {
    // the panel is kept under what opens (a phone's sheet is not: useOpenMessage leaves it out there)
    const keep = [bookmarksEntry(tab)];
    if (to.type === 'message') void openMessage(to.target, keep, { land: true });
    else if (to.type === 'href') {
      if (narrow) void navigate(to.to);
      else {
        const at = withPanel(to.to, keep);
        void navigate({ pathname: at.pathname, search: at.search }, { state: at.state });
      }
    } else if (narrow) panel.replace(to.entry);
    else panel.push(to.entry);
  };
  const setTab = (next: BookmarkTabId): void => panel.replace(bookmarksEntry(next));
  return (
    <div className="bkp" data-testid="bookmarks-panel" tabIndex={-1}>
      {supported ? null : <p className="bk-note">Bookmarks are not available on this server.</p>}
      <BookmarksList tab={tab} onTab={setTab} onOpen={go} scope="panel" />
      {slug ? (
        <Link className="bkp-page" to={`/t/${slug}/bookmarks?tab=${tab}`} data-testid="bookmarks-open-page">Open as a page</Link>
      ) : null}
    </div>
  );
}
