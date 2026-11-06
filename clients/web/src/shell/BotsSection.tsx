import { Link, NavLink, useLocation } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { useQuery } from '../app/useQuery';
import { fetchBots } from '../screens/bots/api';
import { botAvailability, useAgentConnections } from '../screens/bots/availability';
import { useSession } from '../app/session';
import { FoldButton } from './FoldButton';
import { navHref } from './nav';
import { useFold } from './sectionFold';

/** Past this many bots the section starts folded (until the person opens it on purpose). */
export const BOTS_FOLD_AT = 5;

/**
 * The "Bots" section of the sidebar contract (SPEC §3): the heading opens the team roster, and under it one row per bot of the team — the
 * row opens that bot's page (`/t/:team/bots/:botSlug`). The empty state is shown only while the team really has none; a server without the
 * bots plugin answers 404 and the section then says the same.
 */
export function BotsSection({ item, slug }: { item: NavContribution; slug: string }) {
  const session = useSession();
  const path = useLocation().pathname;
  const q = useQuery(`sidebar-bots:${slug}`, () => fetchBots(slug));
  const connections = useAgentConnections();
  const bots = q.status === 'ok' ? q.data.bots : [];
  const [folded, toggleFolded] = useFold(session.person.id, slug, 'bots', bots.length > BOTS_FOLD_AT);
  const href = navHref(item, slug);
  const empty = q.status !== 'loading' && bots.length === 0;
  const heading = (
    <>
      <span>{item.label}</span>
      {empty && item.emptyState ? <span className="hint">{item.emptyState}</span> : null}
    </>
  );
  return (
    <>
      <div className="sec-row">
        {bots.length > 0 ? <FoldButton folded={folded} label={item.label} onToggle={toggleFolded} /> : null}
        {href ? <Link className="sec sec-link" to={href}>{heading}</Link> : <div className="sec">{heading}</div>}
      </div>
      {bots.length > 0 ? (
        <div className="bot-list" data-slot="bots">
          {bots.filter((b) => !folded || path.endsWith(`/bots/${b.slug}`)).map((b) => {
            const a = botAvailability(b, connections);
            return (
              <NavLink
                key={b.id}
                to={`/t/${slug}/bots/${b.slug}`}
                className={({ isActive }) => `it ${isActive ? 'on' : ''}`}
                data-testid="sidebar-bot"
                data-bot={b.slug}
              >
                <span className="h"><span className={`dot ${a.tone}`} aria-hidden="true" title={`${a.label}. ${a.hint}`} /></span>
                <span className="it-label">{b.name}</span>
              </NavLink>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
