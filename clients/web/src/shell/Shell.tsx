import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useMatch } from 'react-router';
import { dmParticipants, useDms } from '../dms/store';
import { Bell } from '../notifications/Bell';
import { SearchBox } from '../search/SearchBox';
import { fetchTeams } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { PeopleContext, useLoadPeople } from '../channels/hooks';
import { RightPanel } from '../kernel/panel';
import { useRealtime } from '../realtime';
import { AccountMenu } from './AccountMenu';
import { ShellContext, type ShellValue } from './context';
import { useNavCounts } from './counts';
import { MenuIcon, SearchIcon } from './icons';
import { GUEST_SLUG } from './messageLink';
import { viewTitle } from './nav';
import { Sidebar } from './Sidebar';
import { HeaderTopicContext } from './topic';
import { TeamSwitch } from './TeamSwitch';
import { useDismiss } from './useDismiss';
import { useNarrow } from './useNarrow';
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
  const counts = useNavCounts();
  const narrow = useNarrow();
  const [topic, setTopic] = useState<string | null>(null);

  useRealtime();
  const teamsData = q.status === 'ok' ? q.data.teams : undefined;
  const teams = useMemo(() => teamsData ?? [], [teamsData]);
  const teamsLoading = q.status === 'loading';
  // `/` has no team in the URL: it shows the team the person was last in, else their first, without changing the URL.
  const team = useMemo(
    () => teams.find((t) => t.slug === (slug ?? recalledTeam())) ?? (slug === null ? (teams[0] ?? null) : null),
    [teams, slug],
  );
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
  const title = dmId ? (dm ? dmParticipants(dm) : 'Direct message') : slug === null && team ? 'Threads' : viewTitle(loc.pathname);
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
      <div className="frame" data-testid="app-frame" data-drawer={drawerOpen ? 'open' : 'closed'}>
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
          <AccountMenu />
        </aside>
        {drawerOpen ? <button type="button" className="scrim" aria-label="Close menu" onClick={() => setOpenedAt(null)} /> : null}
        <main className="center">
          {inboxOwnsHeader ? null : (
          <header className="region header chead" data-landmark="header">
            <button type="button" className="icon-btn menu-btn" aria-label="Open menu" aria-controls="shell-rail" aria-expanded={drawerOpen} onClick={() => setOpenedAt(loc.pathname + loc.search)}>
              <MenuIcon />
            </button>
            <h1 className="chead-title">
              <span className="sr-only">{`${session.workspace.name}: `}</span>
              {title}
            </h1>
            {topic ? <span className="topic" data-testid="channel-topic">{topic}</span> : null}
            <div className="right chead-tools">
              {dmId && dm ? <SearchBox className="head-search" placeholder="Search this conversation" label="Search this conversation" channelId={dmId} /> : null}
              <button type="button" className="icon-btn find-btn" aria-label="Find" onClick={openSearch}>
                <SearchIcon />
              </button>
              <Bell />
            </div>
          </header>
          )}
          <section className="region content" data-landmark="content" aria-busy={teamsLoading || undefined}>
            <Outlet />
          </section>
        </main>
        <RightPanel />
      </div>
      </HeaderTopicContext.Provider>
      </PeopleContext.Provider>
    </ShellContext.Provider>
  );
}
