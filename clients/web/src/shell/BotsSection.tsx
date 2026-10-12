import { Link, NavLink } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { useQuery } from '../app/useQuery';
import { fetchBots } from '../screens/bots/api';
import { navHref } from './nav';

/**
 * The "Bots" section of the sidebar contract (SPEC §3): the heading opens the team roster, and under it one row per bot of the team — the
 * row opens that bot's page (`/t/:team/bots/:botSlug`). The empty state is shown only while the team really has none; a server without the
 * bots plugin answers 404 and the section then says the same.
 */
export function BotsSection({ item, slug }: { item: NavContribution; slug: string }) {
  const q = useQuery(`sidebar-bots:${slug}`, () => fetchBots(slug));
  const bots = q.status === 'ok' ? q.data.bots : [];
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
      {href ? <Link className="sec sec-link" to={href}>{heading}</Link> : <div className="sec">{heading}</div>}
      {bots.length > 0 ? (
        <div className="bot-list" data-slot="bots">
          {bots.map((b) => (
            <NavLink
              key={b.id}
              to={`/t/${slug}/bots/${b.slug}`}
              className={({ isActive }) => `it ${isActive ? 'on' : ''}`}
              data-testid="sidebar-bot"
              data-bot={b.slug}
            >
              <span className="h"><span className={`dot ${b.status === 'active' ? 'up' : 'off'}`} aria-hidden="true" /></span>
              <span className="it-label">{b.name}</span>
            </NavLink>
          ))}
        </div>
      ) : null}
    </>
  );
}
