import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useMatch } from 'react-router';
import { fetchTeams } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { RightPanel } from '../kernel/panel';
import { AccountMenu } from './AccountMenu';
import { ShellContext, type ShellValue } from './context';
import { useNavCounts } from './counts';
import { MenuIcon, SearchIcon } from './icons';
import { viewTitle } from './nav';
import { Sidebar } from './Sidebar';
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
  const slug = useMatch('/t/:team/*')?.params.team ?? null;
  const q = useQuery('shell-teams', () => fetchTeams());
  const counts = useNavCounts();
  const narrow = useNarrow();

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

  // The drawer is open for one location only: moving anywhere closes it, with no effect needed.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const drawerOpen = narrow && openedAt === loc.pathname + loc.search;
  const rail = useRef<HTMLElement>(null);
  useDismiss(drawerOpen, () => setOpenedAt(null), rail);

  const title = slug === null && team ? 'Threads' : viewTitle(loc.pathname);
  return (
    <ShellContext.Provider value={value}>
      <div className="frame" data-testid="app-frame" data-drawer={drawerOpen ? 'open' : 'closed'}>
        <aside className="rail" id="shell-rail" ref={rail} aria-label="Workspace" inert={narrow && !drawerOpen}>
          <div className="ws">
            <span className="mark" aria-hidden="true">{session.workspace.name.slice(0, 1).toUpperCase()}</span>
            <b className="ws-name">{session.workspace.name}</b>
          </div>
          <div className="region team-switch" data-landmark="team-switch">
            <TeamSwitch />
          </div>
          <div className="region search" data-landmark="search">
            <label className="search-box">
              <SearchIcon />
              <span className="sr-only">Search</span>
              <input type="search" readOnly placeholder={team && !guest ? `Search ${team.name}` : 'Search'} aria-label="Search" />
            </label>
          </div>
          <nav className="region sidebar" data-landmark="sidebar" aria-label="Sidebar">
            <Sidebar />
          </nav>
          <AccountMenu />
        </aside>
        {drawerOpen ? <button type="button" className="scrim" aria-label="Close menu" onClick={() => setOpenedAt(null)} /> : null}
        <main className="center">
          <header className="region header chead" data-landmark="header">
            <button type="button" className="icon-btn menu-btn" aria-label="Open menu" aria-controls="shell-rail" aria-expanded={drawerOpen} onClick={() => setOpenedAt(loc.pathname + loc.search)}>
              <MenuIcon />
            </button>
            <h1 className="chead-title">
              <span className="sr-only">{`${session.workspace.name}: `}</span>
              {title}
            </h1>
          </header>
          <section className="region content" data-landmark="content" aria-busy={teamsLoading || undefined}>
            <Outlet />
          </section>
        </main>
        <RightPanel />
      </div>
    </ShellContext.Provider>
  );
}
