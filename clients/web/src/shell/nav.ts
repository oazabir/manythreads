import { NavContribution, sortNav } from '@manythreads/shared';

/*
 * The sidebar contract (SPEC section 3): Chat (5) · Files (10) · Boards (20) · Org chart (23) · Jobs (26) · Threads (30) · Approvals (35) ·
 * channel groups (40) · Direct messages (45) · Bots (50). The entries are a declarative `surface.nav` contribution list sorted by `order`;
 * a plugin adds its own entry the same way. Entries whose plugin is not loaded yet show their empty state.
 */
export const CORE_NAV: NavContribution[] = [
  { id: 'chat', order: 5, label: 'Chat', kind: 'item', path: '/chat', icon: 'chat', badge: { source: 'chat.unread', tone: 'unread' } },
  { id: 'files', order: 10, label: 'Files', kind: 'item', path: '/files', icon: 'files' },
  { id: 'boards', order: 20, label: 'Boards', kind: 'item', path: '/boards', icon: 'boards' },
  { id: 'org', order: 23, label: 'Org chart', kind: 'item', path: '/org', icon: 'org' },
  { id: 'jobs', order: 26, label: 'Jobs', kind: 'item', path: '/jobs', icon: 'jobs' },
  { id: 'threads', order: 30, label: 'Threads', kind: 'item', path: '/threads', icon: 'threads', badge: { source: 'threads.unread', tone: 'unread' } },
  { id: 'approvals', order: 35, label: 'Approvals', kind: 'item', path: '/approvals', icon: 'approvals', badge: { source: 'approvals.waiting', tone: 'quiet' } },
  { id: 'channels', order: 40, label: 'Channels', kind: 'group-list', guests: true },
  { id: 'direct-messages', order: 45, label: 'Direct messages', kind: 'header', emptyState: 'No conversations yet' },
  { id: 'bots', order: 50, label: 'Bots', kind: 'header', path: '/bots', emptyState: 'No bots yet' },
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

/** The tone of an entry's badge: its own, except that Approvals turns `attention` (amber) while anything has waited over a day. */
export function navTone(item: NavContribution, counts: Readonly<Record<string, number>>): 'unread' | 'quiet' | 'attention' | 'mention' {
  if (item.badge?.source === 'approvals.waiting' && (counts['approvals.overdue'] ?? 0) > 0) return 'attention';
  return item.badge?.tone ?? 'unread';
}

export const channelPath = (teamSlug: string, name: string): string => `/t/${teamSlug}/c/${encodeURIComponent(name.replace(/^#/, ''))}`;

const SECTIONS = ['chat', 'threads', 'files', 'boards', 'org', 'jobs', 'approvals', 'bots', 'recipes', 'memory', 'knowledge'] as const;

/** Switching teams keeps the section (`/t/a/files` to `/t/b/files`); a channel or DM is a team's own, so it lands on Threads. */
export function teamSwitchPath(pathname: string, toSlug: string): string {
  const m = /^\/t\/[^/]+\/([^/]+)/.exec(pathname);
  const section = SECTIONS.find((s) => s === m?.[1]) ?? 'threads';
  return `/t/${toSlug}/${section}`;
}

const TITLES: Record<string, string> = { chat: 'Chat', threads: 'Threads', files: 'Files', boards: 'Boards', org: 'Org chart', jobs: 'Jobs', approvals: 'Approvals', bots: 'Bots', recipes: 'Recipes', memory: 'Memory', knowledge: 'Knowledge', agents: 'Agents', projects: 'Projects', proposals: 'Proposals', search: 'Search' };

/** The header title of the shell for a path. */
export function viewTitle(pathname: string): string {
  if (pathname === '/files' || pathname.startsWith('/files/')) return 'Files';
  // a person's own Memory and Knowledge sit outside any team
  if (pathname === '/memory') return 'Memory';
  if (pathname === '/knowledge') return 'Knowledge';
  const m = /^\/t\/[^/]+\/([^/]+)(?:\/([^/]+))?/.exec(pathname);
  if (!m) return 'Home';
  const [, section = '', rest] = m;
  if (section === 'c' && rest) return `# ${decodeURIComponent(rest)}`;
  if (section === 'dm') return 'Direct message';
  if (section === 'chat' && rest) return 'Conversation';
  if (section === 'bots' && /^\/t\/[^/]+\/bots\/[^/]+\/chat\/?$/.test(pathname)) return 'Conversation';
  return TITLES[section] ?? 'Home';
}
