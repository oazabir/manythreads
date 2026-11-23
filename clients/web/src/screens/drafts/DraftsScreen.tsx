import { Link } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { useDraftPlaces } from '../../channels/draftPlaces';

/*
 * Drafts (owner, 2026-11-23): every message not yet sent, from any channel, thread, direct message, meeting or chat with a bot, newest first. Opening one goes
 * back to its box with the text in it. They live in this browser only.
 */

const when = (at: number): string => {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export function DraftsScreen() {
  const drafts = useDraftPlaces();
  return (
    <div className="dr-screen" data-testid="drafts">
      <PageHeader title="Drafts" description={drafts.length === 0 ? undefined : `${drafts.length} not sent yet · kept in this browser`} />
      <div className="dr-body">
        {drafts.length === 0 ? <p className="dr-empty">No drafts. What you type and do not send is kept here.</p> : null}
        <ul className="dr-list" aria-label="Drafts">
          {drafts.map((d) => (
            <li key={d.key}>
              <Link to={d.path} className="dr-item" data-testid="draft-item" data-key={d.key}>
                <span className="dr-head">
                  <span className="dr-place">{d.label}</span>
                  <span className="dr-when">{when(d.at)}</span>
                </span>
                <span className="dr-text">{d.preview}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
