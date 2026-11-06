import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useMatch } from 'react-router';
import { dmLabel, useDms } from '../dms/store';
import { Bell } from '../notifications/Bell';
import { InboxNotices } from '../screens/memory/InboxNotices';
import { MeetingHost } from '../meetings/MeetingHost';
import { PushBridge } from '../notifications/OpenLink';
import { DndLive } from '../presence/DndIndicators';
import { useHeartbeat, useWatchMyPresence } from '../presence/hooks';
import { SearchBox } from '../search/SearchBox';
import { fetchTeams } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { PeopleContext, useLoadPeople } from '../channels/hooks';
import { RightPanel } from '../kernel/panel';
import { useRealtime } from '../realtime';
import { AccountMenu } from './AccountMenu';
import { crumbsFor } from './breadcrumb';
import { ShellContext, type ShellValue } from './context';
import { useNavCounts } from './counts';
import { MenuIcon, SearchIcon } from './icons';
import { GUEST_SLUG } from './messageLink';
import { viewTitle } from './nav';
import { SetupCard } from './SetupCard';
import { Sidebar } from './Sidebar';
import { CrumbTailContext, HeaderActionsContext, HeaderTitleContext, HeaderTopicContext, PageHeaderRegistry } from './topic';
import { TeamSwitch } from './TeamSwitch';
import { useDismiss } from './useDismiss';
import { useNarrow } from './useNarrow';
import { useTabState } from './useTabState';
import { recalledTeam, rememberTeam } from './views';

/**
 * The app shell (PLAN P3-12): workspace and team switch, search, the sidebar contract, the account menu; the centre column
 * with its header; and the right panel. On a phone the sidebar is a drawer behind a hamburger and the panel a full-height sheet.
 */
export function Shell() {
  const session = useSession();
  const guest = session.role === 'guest';
  const loc = useLocation();
  const urlSlug = useMatch('/t/:team/*')?.params.team ?? null;
  // a guest has no team to name: any slug shows the channels they were granted, so the shell uses a fixed one at `/`
  const slug = urlSlug ?? (guest ? GUEST_SLUG : null);
  const dmId = useMatch('/t/:team/dm/:id')?.params.id ?? null;
  const onThreads = useMatch('/t/:team/threads') !== null || loc.pathname === '/';
  const q = useQuery('shell-teams', () => fetchTeams());
  const narrow = useNarrow();
  const [topic, setTopic] = useState<string | null>(null);
  const [titleNode, setTitleNode] = useState<ReactNode>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [crumbTail, setCrumbTail] = useState<string | null>(null);
  // how many PageHeaders are on screen: while one is, the band shows the trail and the page's own h1 is the title
  const [headers, setHeaders] = useState(0);
  const registerHeader = useCallback((delta: 1 | -1) => setHeaders((n) => Math.max(0, n + delta)), []);

  useRealtime();
  useWatchMyPresence(session.person.id);
  useHeartbeat(session.person.id);
  const teamsData = q.status === 'ok' ? q.data.teams : undefined;
  const teams = useMemo(() => teamsData ?? [], [teamsData]);
  const teamsLoading = q.status === 'loading';
  // `/` has no team in the URL: it shows the team the person was last in, else their first, without changing the URL.
  const team = useMemo(
    () => teams.find((t) => t.slug === (slug ?? recalledTeam())) ?? (slug === null ? (teams[0] ?? null) : null),
    [teams, slug],
  );
  // the pills of the sidebar contract: unread threads, and what waits in the team's Approvals inbox (a guest has neither)
  const counts = useNavCounts(guest ? null : (team?.slug ?? null));
  const value = useMemo<ShellValue>(() => ({ teams, teamsLoading, team, teamSlug: slug, guest, counts }), [teams, teamsLoading, team, slug, guest, counts]);

  useEffect(() => {
    if (team) rememberTeam(team.slug);
  }, [team]);
  const people = useLoadPeople(guest ? null : (team?.slug ?? null));
  const dms = useDms(!guest);
  const dm = dmId ? dms.items.find((d) => d.channel.id === dmId) : undefined;

  // The drawer is open for one location only: moving anywhere closes it, with no effect needed.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const drawerOpen = narrow && openedAt === loc.pathname + loc.search;
  const rail = useRef<HTMLElement>(null);
  useDismiss(drawerOpen, () => setOpenedAt(null), rail);

  // On a wide screen the Threads inbox draws its own two header bands (list: title and tabs; thread: its name and actions, as in the prototype), so the
  // shell's band is left out there; the bell then sits in the thread's band.
  const inboxOwnsHeader = onThreads && !narrow && !guest && team !== null;
  const title = dmId ? (dm ? dmLabel(dm, session.person.id) : 'Direct message') : slug === null && team ? 'Threads' : viewTitle(loc.pathname);
  const onChat = dmId !== null || /^\/t\/[^/]+\/c\//.test(loc.pathname);
  const trail = crumbsFor(loc.pathname, team?.name ?? null, crumbTail);
  // the tab says where the person is and how much waits (a guest has no team); a page title set by a PageHeader h1 wins over the generic one
  const place = dmId ? title : crumbTail ?? title;
  useTabState({ place, team: team?.name ?? null, enabled: !teamsLoading });
  const pageOwnsTitle = !onChat && headers > 0;
  const searchLabel = guest ? 'Search' : team ? `Search ${team.name}` : 'Search';
  const railSearch = useRef<HTMLDivElement>(null);
  const openSearch = (): void => {
    setOpenedAt(loc.pathname + loc.search);
    // the box sits in the drawer: focus it once the drawer has opened
    window.setTimeout(() => railSearch.current?.querySelector('input')?.focus(), 60);
  };
  return (
    <ShellContext.Provider value={value}>
      <PeopleContext.Provider value={people}>
      <HeaderTopicContext.Provider value={setTopic}>
      <HeaderTitleContext.Provider value={setTitleNode}>
      <HeaderActionsContext.Provider value={actionsSlot}>
      <CrumbTailContext.Provider value={setCrumbTail}>
      <PageHeaderRegistry.Provider value={registerHeader}>
      <div className="frame" data-testid="app-frame" data-drawer={drawerOpen ? 'open' : 'closed'}>
        <a className="skip-link" href="#content" onClick={(e) => { e.preventDefault(); document.getElementById('content')?.focus(); }}>{onChat ? 'Skip to messages' : 'Skip to content'}</a>
        <aside className="rail" id="shell-rail" ref={rail} aria-label="Workspace" inert={narrow && !drawerOpen}>
          <div className="ws">
            <span className="mark" aria-hidden="true">{session.workspace.name.slice(0, 1).toUpperCase()}</span>
            <b className="ws-name">{session.workspace.name}</b>
          </div>
          <div className="region team-switch" data-landmark="team-switch">
            <TeamSwitch />
          </div>
          <div className="region search" data-landmark="search" ref={railSearch}>
            <SearchBox placeholder={searchLabel} label="Search" />
          </div>
          <nav className="region sidebar" data-landmark="sidebar" aria-label="Sidebar">
            <Sidebar />
          </nav>
          <SetupCard />
          <AccountMenu />
        </aside>
        {drawerOpen ? <button type="button" className="scrim" aria-label="Close menu" onClick={() => setOpenedAt(null)} /> : null}
        <DndLive />
        <main className="center">
          {inboxOwnsHeader ? null : (
          <header className="region header chead" data-landmark="header">
            <button type="button" className="icon-btn menu-btn" aria-label="Open menu" aria-controls="shell-rail" aria-expanded={drawerOpen} onClick={() => setOpenedAt(loc.pathname + loc.search)}>
              <MenuIcon />
            </button>
            {pageOwnsTitle ? (
              <nav className="crumbs" aria-label="Breadcrumb">
                <ol>
                  {trail.map((c, i) => (
                    <li key={`${i}-${c.label}`} className={i === trail.length - 1 ? 'crumb-last' : undefined} aria-current={i === trail.length - 1 ? 'page' : undefined}>
                      {c.to ? <Link to={c.to}>{c.label}</Link> : c.label}
                    </li>
                  ))}
                </ol>
              </nav>
            ) : (
              <>
                <h1 className="chead-title">
                  <span className="sr-only">{`${session.workspace.name}: `}</span>
                  {titleNode ?? title}
                </h1>
                {topic ? <span className="topic" data-testid="channel-topic" title={topic}>{topic}</span> : null}
              </>
            )}
            <div className="right chead-tools">
              <div className="chead-actions" ref={setActionsSlot} />
              <button type="button" className="icon-btn find-btn" aria-label="Find" onClick={openSearch}>
                <SearchIcon />
              </button>
              <Bell />
            </div>
          </header>
          )}
          <section className="region content" id="content" tabIndex={-1} data-landmark="content" aria-busy={teamsLoading || undefined}>
            <PushBridge />
            <InboxNotices />
            <Outlet />
          </section>
          <MeetingHost />
        </main>
        <RightPanel />
      </div>
      </PageHeaderRegistry.Provider>
      </CrumbTailContext.Provider>
      </HeaderActionsContext.Provider>
      </HeaderTitleContext.Provider>
      </HeaderTopicContext.Provider>
      </PeopleContext.Provider>
    </ShellContext.Provider>
  );
}
