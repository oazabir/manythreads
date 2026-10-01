import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { fetchTeams } from '../api/endpoints';
import type { TeamSummary } from '../api/schemas';
import { isAdmin, useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { Brand } from './ui';

/** Centred card for sign-in, bootstrap and invite screens. */
export function AuthFrame({ title, lede, children, footer }: { title: string; lede?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth" data-testid="app-frame">
      <main className="auth-card" data-landmark="auth-card">
        <header data-landmark="header">
          <Brand />
        </header>
        <h1 className="auth-title">{title}</h1>
        {lede ? <p className="auth-lede">{lede}</p> : null}
        <div data-landmark="content">{children}</div>
        {footer ? <p className="auth-foot" data-landmark="footer">{footer}</p> : null}
      </main>
    </div>
  );
}

/** Page with a slim top bar (account). */
export function PlainFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  const session = useSession();
  return (
    <div className="plain" data-testid="app-frame">
      <header className="plain-bar" data-landmark="header">
        <Link to="/" className="plain-brand"><Brand name={session.workspace.name} mark={session.workspace.name.slice(0, 1)} /></Link>
        <nav className="plain-links" aria-label="Main">
          <Link to="/">Back to manythreads</Link>
          <Link to="/teams">Teams</Link>
          {isAdmin(session) ? <Link to="/settings/workspace/general">Settings</Link> : null}
        </nav>
      </header>
      <main className="plain-body" data-landmark="content">
        <h1 className="page-title">{title}</h1>
        {children}
      </main>
    </div>
  );
}

// ---- settings frame -------------------------------------------------------------------------------------
type TeamsContextValue = { teams: TeamSummary[]; loading: boolean; reload: () => void };
const TeamsContext = createContext<TeamsContextValue>({ teams: [], loading: true, reload: () => undefined });
export const useTeams = (): TeamsContextValue => useContext(TeamsContext);

type NavItem = { to: string; label: string };
type NavGroup = { heading: string; to?: string; items: NavItem[]; empty?: string };

export function SettingsFrame() {
  const session = useSession();
  const loc = useLocation();
  const navigate = useNavigate();
  const q = useQuery('settings-teams', fetchTeams);
  const loaded = q.status === 'ok' ? q.data : undefined;
  const teams = useMemo(() => loaded ?? [], [loaded]);
  const teamsValue = useMemo<TeamsContextValue>(() => ({ teams, loading: q.status === 'loading', reload: q.reload }), [teams, q.status, q.reload]);

  const settingsMatch = useMatch('/settings/team/:slug/*');
  const teamMatch = useMatch('/teams/:slug');
  const activeSlug = settingsMatch?.params.slug ?? teamMatch?.params.slug ?? teams[0]?.slug;
  const activeTeam = teams.find((t) => t.slug === activeSlug);
  const admin = isAdmin(session);

  const groups: NavGroup[] = [];
  if (admin) {
    groups.push({
      heading: 'Workspace',
      items: [
        { to: '/settings/workspace/general', label: 'General' },
        { to: '/settings/workspace/sign-in', label: 'Sign-in' },
        { to: '/settings/workspace/members', label: 'Members' },
        { to: '/settings/workspace/roles', label: 'Roles' },
      ],
    });
  }
  groups.push({
    heading: 'Teams',
    to: '/teams',
    items: [
      ...teams.map((t) => ({ to: `/settings/team/${t.slug}/roster`, label: t.name })),
      ...(admin ? [{ to: '/teams', label: '＋ New team' }] : []),
    ],
    empty: q.status === 'loading' ? undefined : 'No teams yet',
  });
  if (activeTeam) {
    groups.push({
      heading: activeTeam.name,
      items: [
        { to: `/settings/team/${activeTeam.slug}/roster`, label: 'Roster' },
        { to: `/settings/team/${activeTeam.slug}/template`, label: 'Template' },
        { to: `/settings/team/${activeTeam.slug}/channels`, label: 'Channels' },
      ],
    });
  }

  // the mobile select needs unique option values; "＋ New team" shares /teams with the Teams heading
  const selectGroups = groups.map((g) => ({
    heading: g.heading,
    items: g.heading === 'Teams' ? [{ to: '/teams', label: 'All teams' }, ...g.items.filter((i) => i.to !== '/teams')] : g.items,
  }));
  const selectValue = selectGroups.flatMap((g) => g.items).some((i) => i.to === loc.pathname) ? loc.pathname : '';

  return (
    <TeamsContext.Provider value={teamsValue}>
      <div className="settings" data-testid="app-frame">
        <aside className="tabs" data-landmark="nav">
          <Link to="/" className="tabs-brand"><Brand name={session.workspace.name} mark={session.workspace.name.slice(0, 1)} /></Link>
          <Link to="/" className="tab back">← Back to manythreads</Link>
          <nav aria-label="Settings">
            {groups.map((g) => (
              <div key={g.heading} className="tgroup">
                {g.to ? (
                  <NavLink to={g.to} end className="tgrp tgrp-link">{g.heading}</NavLink>
                ) : (
                  <div className="tgrp">{g.heading}</div>
                )}
                {g.items.length === 0 && g.empty ? <div className="tab faint">{g.empty}</div> : null}
                {g.items.map((i) => (
                  <NavLink key={`${g.heading}${i.to}${i.label}`} to={i.to} end className={({ isActive }) => `tab ${isActive && !i.label.startsWith('＋') ? 'on' : ''} ${i.label.startsWith('＋') ? 'faint' : ''}`}>
                    {i.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <Link to="/account" className="tab account-link">Account · {session.person.name}</Link>
        </aside>
        <div className="settings-main">
          <div className="settings-select" data-landmark="nav-select">
            <label htmlFor="settings-section">Settings section</label>
            <select id="settings-section" value={selectValue} onChange={(e) => navigate(e.target.value)}>
              {selectValue === '' ? <option value="" disabled>Choose…</option> : null}
              {selectGroups.map((g) => (
                <optgroup key={g.heading} label={g.heading}>
                  {g.items.map((i) => <option key={i.to} value={i.to}>{i.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <main className="pane" data-landmark="content">
            <Outlet />
          </main>
        </div>
      </div>
    </TeamsContext.Provider>
  );
}
