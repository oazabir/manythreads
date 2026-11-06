import { PageHeader } from './PageHeader';
import { createContext, useContext, useId, useMemo, type ComponentType, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router';
import { fetchTeams } from '../api/endpoints';
import type { TeamSummary } from '@manythreads/shared';
import { isAdmin, useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { useHeartbeat, useWatchMyPresence } from '../presence/hooks';
import { Brand } from './ui';
import {
  AddIcon, BackIcon, BellIcon, HashIcon, HookIcon, SettingsAuditIcon, SettingsDataIcon, SettingsDomainIcon, SettingsGeneralIcon, SettingsHealthIcon,
  SettingsImportIcon, SettingsLlmIcon, SettingsMemoryIcon, SettingsMembersIcon, SettingsProfileIcon, SettingsRolesIcon, SettingsRunnersIcon,
  SettingsSecurityIcon, SettingsSetupIcon, SettingsSignInIcon, SettingsTemplateIcon, SettingsUsageIcon,
} from '../shell/icons';
import { useDocumentTitle } from '../shell/usePageTitle';

/** The card for sign-in, bootstrap, invite and error pages. A `tagline` makes it the sign-in card: the product name large with the line under it, and a wider card on a desktop. */
export function AuthFrame({ title, lede, children, footer, tagline }: { title: string; lede?: ReactNode; children: ReactNode; footer?: ReactNode; tagline?: string }) {
  useDocumentTitle(title);
  return (
    <div className="auth" data-testid="app-frame">
      <main className={tagline ? 'auth-card hero' : 'auth-card'} data-landmark="auth-card">
        <header data-landmark="header">
          <Brand />
          {tagline ? <p className="auth-tagline" data-testid="auth-tagline">{tagline}</p> : null}
        </header>
        <h1 className="auth-title" data-landmark="title">{title}</h1>
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
  useDocumentTitle(typeof title === 'string' ? title : null);
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
        <PageHeader title={title} />
        {children}
      </main>
    </div>
  );
}

// ---- settings frame -------------------------------------------------------------------------------------
type TeamsContextValue = { teams: TeamSummary[]; loading: boolean; reload: () => void };
const TeamsContext = createContext<TeamsContextValue>({ teams: [], loading: true, reload: () => undefined });
export const useTeams = (): TeamsContextValue => useContext(TeamsContext);

type NavItem = { to: string; label: string; icon?: ComponentType<{ size?: number }>; quiet?: boolean };
type NavGroup = { heading: string; to?: string; items: NavItem[]; empty?: string };

/** The workspace pages an admin sees, in four groups (P21-19); the order inside a group is the order on screen. */
export const WORKSPACE_NAV: ReadonlyArray<{ heading: string; items: ReadonlyArray<NavItem> }> = [
  {
    heading: 'People',
    items: [
      { to: '/settings/workspace/general', label: 'General', icon: SettingsGeneralIcon },
      { to: '/settings/workspace/members', label: 'Members', icon: SettingsMembersIcon },
      { to: '/settings/workspace/roles', label: 'Roles', icon: SettingsRolesIcon },
      { to: '/settings/workspace/sign-in', label: 'Sign-in', icon: SettingsSignInIcon },
    ],
  },
  {
    heading: 'Bots and models',
    items: [
      { to: '/settings/workspace/llm', label: 'LLM', icon: SettingsLlmIcon },
      { to: '/settings/workspace/runners', label: 'Runners', icon: SettingsRunnersIcon },
      { to: '/settings/workspace/memory-sharing', label: 'Memory sharing', icon: SettingsMemoryIcon },
    ],
  },
  {
    heading: 'Security',
    items: [
      { to: '/settings/workspace/guardrails', label: 'Data protection', icon: SettingsDataIcon },
      { to: '/settings/workspace/https', label: 'Domain & HTTPS', icon: SettingsDomainIcon },
      { to: '/settings/workspace/audit', label: 'Audit', icon: SettingsAuditIcon },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { to: '/onboarding', label: 'Setup', icon: SettingsSetupIcon },
      { to: '/settings/workspace/health', label: 'System health', icon: SettingsHealthIcon },
      { to: '/settings/workspace/usage', label: 'Usage', icon: SettingsUsageIcon },
      { to: '/settings/workspace/import', label: 'Import', icon: SettingsImportIcon },
    ],
  },
];

export function SettingsFrame() {
  const session = useSession();
  // the roster and other settings pages show presence dots too; they sit outside the shell, so they keep the heartbeat and the cards themselves
  useWatchMyPresence(session.person.id);
  useHeartbeat(session.person.id);
  const loc = useLocation();
  const navigate = useNavigate();
  const q = useQuery('settings-teams', fetchTeams);
  const loaded = q.status === 'ok' ? q.data.teams : undefined;
  const teams = useMemo(() => loaded ?? [], [loaded]);
  const teamsValue = useMemo<TeamsContextValue>(() => ({ teams, loading: q.status === 'loading', reload: q.reload }), [teams, q.status, q.reload]);

  const settingsMatch = useMatch('/settings/team/:slug/*');
  const teamMatch = useMatch('/teams/:slug');
  const activeSlug = settingsMatch?.params.slug ?? teamMatch?.params.slug ?? teams[0]?.slug;
  const activeTeam = teams.find((t) => t.slug === activeSlug);
  const admin = isAdmin(session);

  const groups: NavGroup[] = [
    {
      heading: 'Account',
      items: [
        { to: '/account/profile', label: 'Profile', icon: SettingsProfileIcon },
        { to: '/account/notifications', label: 'Notifications', icon: BellIcon },
        { to: '/account/connections', label: 'Connections', icon: HookIcon },
        { to: '/account/security', label: 'Security', icon: SettingsSecurityIcon },
      ],
    },
  ];
  if (admin) groups.push(...WORKSPACE_NAV.map((g) => ({ heading: g.heading, items: [...g.items] })));
  // a guest has no teams to manage: only their Account pages are drawn
  if (session.role !== 'guest') {
    groups.push({
      heading: 'Teams',
      to: '/teams',
      items: [
        ...teams.map((t) => ({ to: `/settings/team/${t.slug}/roster`, label: t.name })),
        ...(admin ? [{ to: '/teams', label: 'New team', icon: AddIcon, quiet: true }] : []),
      ],
      empty: q.status === 'loading' ? undefined : 'No teams yet',
    });
  }
  if (activeTeam && session.role !== 'guest') {
    groups.push({
      heading: activeTeam.name,
      items: [
        { to: `/settings/team/${activeTeam.slug}/roster`, label: 'Roster', icon: SettingsMembersIcon },
        { to: `/settings/team/${activeTeam.slug}/template`, label: 'Template', icon: SettingsTemplateIcon },
        { to: `/settings/team/${activeTeam.slug}/channels`, label: 'Channels', icon: HashIcon },
        { to: `/settings/team/${activeTeam.slug}/connections`, label: 'Connections', icon: HookIcon },
        { to: `/settings/team/${activeTeam.slug}/usage`, label: 'Usage', icon: SettingsUsageIcon },
      ],
    });
  }

  // the mobile select needs unique option values; "New team" shares /teams with the Teams heading
  const selectGroups = groups.map((g) => ({
    heading: g.heading,
    items: g.heading === 'Teams' ? [{ to: '/teams', label: 'All teams' }, ...g.items.filter((i) => i.to !== '/teams')] : g.items,
  }));
  useDocumentTitle(groups.flatMap((g) => g.items).find((i) => i.to === loc.pathname)?.label ?? 'Settings');
  const selectValue = selectGroups.flatMap((g) => g.items).some((i) => i.to === loc.pathname) ? loc.pathname : '';

  return (
    <TeamsContext.Provider value={teamsValue}>
      <div className="settings" data-testid="app-frame">
        <aside className="tabs" data-landmark="nav">
          <div className="tabs-sticky">
            <Link to="/" className="tabs-brand"><Brand name={session.workspace.name} mark={session.workspace.name.slice(0, 1)} /></Link>
            <Link to="/" className="tab back"><BackIcon size={12} /> Back to manythreads</Link>
            <nav aria-label="Settings" className="tabs-nav">
              {groups.map((g) => (
                <NavSection key={g.heading} group={g} />
              ))}
            </nav>
          </div>
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

/** One group of the settings navigation: a heading (a link for Teams) and its items, each with an icon. */
function NavSection({ group: g }: { group: NavGroup }) {
  const headingId = useId();
  return (
    <div className="tgroup" role="group" aria-labelledby={headingId}>
      {g.to ? (
        <NavLink to={g.to} end id={headingId} className="tgrp tgrp-link">{g.heading}</NavLink>
      ) : (
        <div className="tgrp" id={headingId}>{g.heading}</div>
      )}
      {g.items.length === 0 && g.empty ? <div className="tab faint">{g.empty}</div> : null}
      {g.items.map((i) => (
        <NavLink key={`${g.heading}${i.to}${i.label}`} to={i.to} end className={({ isActive }) => `tab ${isActive && !i.quiet ? 'on' : ''} ${i.quiet ? 'faint' : ''}`}>
          {i.icon ? <span className="tab-ico"><i.icon size={15} /></span> : null}
          <span className="tab-label">{i.label}</span>
        </NavLink>
      ))}
    </div>
  );
}
