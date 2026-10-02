import { NavContribution, sortNav } from '@manythreads/shared';

/*
 * The sidebar contract (SPEC section 3): Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) ·
 * Direct messages (45) · Bots (50). The entries are a declarative `surface.nav` contribution list sorted by `order`; a plugin
 * adds its own entry the same way. Entries whose plugin is not loaded yet show their empty state.
 */
export const CORE_NAV: NavContribution[] = [
  { id: 'files', order: 10, label: 'Files', kind: 'item', path: '/files', icon: 'files', emptyState: 'No files yet' },
  { id: 'boards', order: 20, label: 'Boards', kind: 'item', path: '/boards', icon: 'boards', emptyState: 'No boards yet' },
  { id: 'threads', order: 30, label: 'Threads', kind: 'item', path: '/threads', icon: 'threads', badge: { source: 'threads.unread', tone: 'unread' } },
  { id: 'approvals', order: 35, label: 'Approvals', kind: 'item', path: '/approvals', icon: 'approvals', emptyState: 'Nothing waiting', badge: { source: 'approvals.waiting', tone: 'quiet' } },
  { id: 'channels', order: 40, label: 'Channels', kind: 'group-list', guests: true },
  { id: 'direct-messages', order: 45, label: 'Direct messages', kind: 'header', emptyState: 'No conversations yet' },
  { id: 'bots', order: 50, label: 'Bots', kind: 'header', path: '~/roster', emptyState: 'No bots yet' },
].map((c) => NavContribution.parse(c));

/** What the sidebar shows this person: sorted by order; a guest keeps only the entries that allow guests. */
export function visibleNav(items: readonly NavContribution[], who: { guest: boolean }): NavContribution[] {
  return sortNav(items).filter((i) => !who.guest || i.guests === true);
}

/** Where an entry leads for a team: `/files` is `/t/<team>/files`, `~/roster` is the team's settings page. */
export function navHref(item: NavContribution, teamSlug: string): string | null {
  if (!item.path) return null;
  if (item.path.startsWith('~/')) return `/settings/team/${teamSlug}/${item.path.slice(2)}`;
  return `/t/${teamSlug}${item.path}`;
}

/** The pill count for an entry, or null when its source has nothing (a count of zero shows nothing). */
export function navCount(item: NavContribution, counts: Readonly<Record<string, number>>): number | null {
  if (!item.badge) return null;
  const n = counts[item.badge.source];
  return typeof n === 'number' && n > 0 ? n : null;
}

export const channelPath = (teamSlug: string, name: string): string => `/t/${teamSlug}/c/${encodeURIComponent(name.replace(/^#/, ''))}`;

const SECTIONS = ['threads', 'files', 'boards', 'approvals'] as const;

/** Switching teams keeps the section (`/t/a/files` to `/t/b/files`); a channel or DM is a team's own, so it lands on Threads. */
export function teamSwitchPath(pathname: string, toSlug: string): string {
  const m = /^\/t\/[^/]+\/([^/]+)/.exec(pathname);
  const section = SECTIONS.find((s) => s === m?.[1]) ?? 'threads';
  return `/t/${toSlug}/${section}`;
}

const TITLES: Record<string, string> = { threads: 'Threads', files: 'Files', boards: 'Boards', approvals: 'Approvals' };

/** The header title of the shell for a path. */
export function viewTitle(pathname: string): string {
  const m = /^\/t\/[^/]+\/([^/]+)(?:\/([^/]+))?/.exec(pathname);
  if (!m) return 'Home';
  const [, section = '', rest] = m;
  if (section === 'c' && rest) return `# ${decodeURIComponent(rest)}`;
  if (section === 'dm') return 'Direct message';
  return TITLES[section] ?? 'Home';
}
