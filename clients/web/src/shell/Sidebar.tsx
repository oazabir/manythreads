import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import type { NavContribution } from '@manythreads/shared';
import { isAdmin, useSession } from '../app/session';
import { useUnread } from '../channels/hooks';
import { levelsStore } from '../notifications/levelsStore';
import { BotsSection } from './BotsSection';
import { useShell } from './context';
import { useChannelFeed } from './channelFeed';
import { DirectMessages } from './DirectMessages';
import { CaretIcon, LockIcon, NAV_ICONS } from './icons';
import { GUEST_SLUG } from './messageLink';
import { CORE_NAV, channelPath, navCount, navHref, visibleNav } from './nav';
import { NewChannelDialog } from './NewChannel';
import { canCreateChannel } from './newChannel';
import { badgeText, unreadLook } from './unreadLook';

function Pill({ n, tone }: { n: number; tone: 'unread' | 'quiet' }) {
  return <span className={`pill ${tone === 'quiet' ? 'g' : ''}`} data-vt-mask>{badgeText(n)}</span>;
}

/** A row of the contract: opens its page, shows its count, or its empty state while there is nothing to count. */
function NavItem({ item, slug }: { item: NavContribution; slug: string }) {
  const { counts } = useShell();
  const atHome = useLocation().pathname === '/';
  const href = navHref(item, slug);
  const count = navCount(item, counts);
  const Icon = item.icon ? NAV_ICONS[item.icon] : null;
  const body = (
    <>
      <span className="ic">{Icon ? <Icon /> : null}</span>
      <span className="it-label">{item.label}</span>
      {count !== null ? <Pill n={count} tone={item.badge?.tone ?? 'unread'} /> : item.emptyState ? <span className="hint">{item.emptyState}</span> : null}
    </>
  );
  return href ? (
    <NavLink to={href} className={({ isActive }) => `it ${isActive || (atHome && item.id === 'threads') ? 'on' : ''} ${count !== null && item.badge?.tone !== 'quiet' ? 'unread' : ''}`}>
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

function ChannelGroups({ slug, guest }: { slug: string; guest: boolean }) {
  const feed = useChannelFeed(slug);
  const { unread } = useUnread();
  const session = useSession();
  const { team } = useShell();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  // The team the dialog was opened for: if the person moves to another team meanwhile, the dialog is gone rather than creating in the wrong one.
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  useEffect(() => setCreatingIn(null), [slug]);
  const mayCreate = !guest && canCreateChannel(team, isAdmin(session));
  // The person's notification levels decide how loudly an unread conversation shows (a muted one keeps a grey count, no bold label).
  useEffect(() => {
    if (!guest) void levelsStore.load();
  }, [guest]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="channel-groups" data-slot="channel-groups">
      {guest && feed.status !== 'loading' && feed.groups.length === 0 ? <p className="side-note">Nothing has been shared with you yet.</p> : null}
      {feed.groups.map((g) => {
        const open = !collapsed.has(g.id);
        return (
          <div key={g.id} className="group">
            <button type="button" className="grp" aria-expanded={open} onClick={() => toggle(g.id)}>
              <span className="car"><CaretIcon open={open} /></span>
              {g.name}
            </button>
            {open
              ? g.channels.map((c) => {
                  const n = unread[c.id] ?? c.unread;
                  const look = unreadLook(n, levels, c.id, 'channel');
                  return (
                    <NavLink key={c.id} to={channelPath(slug, c.name)} className={({ isActive }) => `it ${isActive ? 'on' : ''} ${look.bold ? 'unread' : ''}`} data-unread={n > 0 ? n : undefined}>
                      <span className="h">{c.isPrivate ? <LockIcon /> : '#'}</span>
                      <span className="it-label">{c.name.replace(/^#/, '')}</span>
                      {look.badge ? <Pill n={n} tone={look.badge} /> : null}
                    </NavLink>
                  );
                })
              : null}
          </div>
        );
      })}
      {mayCreate ? (
        <div className="nc-row">
          <button type="button" className="it nc-btn" aria-haspopup="dialog" data-testid="new-channel" onClick={() => setCreatingIn(slug)}>
            <span className="h" aria-hidden="true">+</span>
            <span className="it-label">New channel</span>
          </button>
        </div>
      ) : null}
      {creatingIn === slug ? <NewChannelDialog slug={slug} onClose={() => setCreatingIn(null)} /> : null}
    </div>
  );
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
