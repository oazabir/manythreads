import { Link, NavLink, useLocation } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { isAdmin, useSession } from '../app/session';
import { BotsSection } from './BotsSection';
import { ChannelGroups } from './ChannelGroups';
import { useShell } from './context';
import { DirectMessages } from './DirectMessages';
import { NAV_ICONS } from './icons';
import { GUEST_SLUG } from './messageLink';
import { CORE_NAV, navCount, navHref, navTone, visibleNav } from './nav';
import { Pill } from './Pill';

/** A row of the contract: opens its page, shows its count, or its empty state while there is nothing to count. */
function NavItem({ item, slug }: { item: NavContribution; slug: string }) {
  const { counts } = useShell();
  const atHome = useLocation().pathname === '/';
  const href = navHref(item, slug);
  const count = navCount(item, counts);
  const tone = navTone(item, counts);
  const Icon = item.icon ? NAV_ICONS[item.icon] : null;
  const body = (
    <>
      <span className="ic">{Icon ? <Icon /> : null}</span>
      <span className="it-label">{item.label}</span>
      {count !== null ? <Pill n={count} tone={tone} {...(tone === 'attention' ? { note: 'some have waited over a day' } : {})} /> : item.emptyState ? <span className="hint">{item.emptyState}</span> : null}
    </>
  );
  return href ? (
    <NavLink to={href} className={({ isActive }) => `it ${isActive || (atHome && item.id === 'threads') ? 'on' : ''} ${count !== null && tone !== 'quiet' && tone !== 'attention' ? 'unread' : ''}`}>
      {body}
    </NavLink>
  ) : (
    <div className="it">{body}</div>
  );
}

/** A section heading (Direct messages, Bots); with a path it opens the section's page. */
function NavHeader({ item, slug }: { item: NavContribution; slug: string }) {
  const href = navHref(item, slug);
  const body = (
    <>
      <span>{item.label}</span>
      {item.emptyState ? <span className="hint">{item.emptyState}</span> : null}
    </>
  );
  return href ? <Link className="sec sec-link" to={href}>{body}</Link> : <div className="sec">{body}</div>;
}

/** The sidebar contract, drawn from the `surface.nav` contributions in order. */
export function Sidebar() {
  const session = useSession();
  const { team, teamSlug, teamsLoading, guest } = useShell();
  const slug = team?.slug ?? (guest ? (teamSlug ?? GUEST_SLUG) : null);
  const items = visibleNav(CORE_NAV, { guest });

  if (!slug) {
    if (teamsLoading) return null;
    return (
      <div className="side-note">
        <p>{guest ? 'Nothing has been shared with you yet.' : 'You are not on a team yet.'}</p>
        {!guest && isAdmin(session) ? <Link to="/teams">Create a team</Link> : null}
      </div>
    );
  }
  return (
    <>
      {items.map((item) =>
        item.kind === 'group-list' ? (
          <ChannelGroups key={item.id} slug={slug} guest={guest} />
        ) : item.id === 'direct-messages' ? (
          <DirectMessages key={item.id} item={item} slug={slug} />
        ) : item.id === 'bots' ? (
          <BotsSection key={item.id} item={item} slug={slug} />
        ) : item.kind === 'header' ? (
          <NavHeader key={item.id} item={item} slug={slug} />
        ) : (
          <NavItem key={item.id} item={item} slug={slug} />
        ),
      )}
    </>
  );
}
