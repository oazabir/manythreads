import { useNavigate, useSearchParams } from 'react-router';
import { BookmarksList } from '../../bookmarks/BookmarksList';
import { tabFrom, type BookmarkOpen } from '../../bookmarks/model';
import { useBookmarksSupported } from '../../bookmarks/store';
import { PageHeader } from '../../components/PageHeader';
import { usePanel } from '../../kernel/panel';
import { useOpenMessage } from '../../shell/messageLink';

/*
 * Bookmarks (P36-08, docs/plans/bookmarks.md): the full-page view of the person's bookmarks (`/t/<team>/bookmarks`, `?tab=thread|message|file`); the same list
 * is the right-hand Bookmarks panel the header button toggles (P37-08, bookmarks/BookmarksPanel.tsx). A row opens where the item lives: a thread with the
 * thread on the right, a message scrolled to and flashed, a reply with its thread on the right and the reply highlighted, a message of a chat with a bot in
 * that chat, highlighted; a file of a team's repository in that team's Files, a Personal file in Personal, an attachment in the right panel.
 */
export function BookmarksScreen() {
  const [params, setParams] = useSearchParams();
  const tab = tabFrom(params.get('tab'));
  const supported = useBookmarksSupported();
  const openMessage = useOpenMessage();
  const navigate = useNavigate();
  const panel = usePanel();
  const go = (to: BookmarkOpen): void => {
    // a bookmark lands on the message itself: a reply highlighted in its thread, a message of a chat with a bot in that chat
    if (to.type === 'message') void openMessage(to.target, [], { land: true });
    else if (to.type === 'href') void navigate(to.to);
    else panel.replace(to.entry);
  };
  return (
    <div className="bk-screen" data-testid="bookmarks-screen">
      <PageHeader title="Bookmarks" description={supported ? 'Threads, messages and files you keep to find again. Only you see them.' : 'Bookmarks are not available on this server.'} />
      <div className="bk-body">
        <BookmarksList tab={tab} onTab={(next) => setParams({ tab: next }, { replace: true })} onOpen={go} />
      </div>
    </div>
  );
}
