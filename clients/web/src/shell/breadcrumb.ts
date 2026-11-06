export interface Crumb {
  label: string;
  /** where the crumb leads; the last crumb is the page itself and has none */
  to: string | null;
}

const SECTION_LABEL: Record<string, string> = {
  threads: 'Threads',
  files: 'Files',
  boards: 'Boards',
  org: 'Org chart',
  jobs: 'Jobs',
  approvals: 'Approvals',
  bots: 'Bots',
  recipes: 'Recipes',
  memory: 'Memory',
  agents: 'Agents',
  projects: 'Projects',
  proposals: 'Proposals',
  search: 'Search',
  chat: 'Conversation',
};

/**
 * The trail the shell band shows on a page that is not a channel or a DM: the team, the section, and (when a screen names it with
 * `useCrumbTail`) the item. `Engineering / Boards`, `Engineering / Bots / Brain`. The team crumb leads to Threads; a page outside a team
 * (settings, account) gives no team crumb.
 */
export function crumbsFor(pathname: string, teamName: string | null, tail?: string | null): Crumb[] {
  const out: Crumb[] = [];
  const m = /^\/t\/([^/]+)\/([^/]+)/.exec(pathname);
  if (!m) {
    if (teamName) out.push({ label: teamName, to: null });
    return out;
  }
  const [, slug = '', section = ''] = m;
  const sectionLabel = SECTION_LABEL[section] ?? null;
  const base = `/t/${slug}`;
  if (teamName) out.push({ label: teamName, to: `${base}/threads` });
  if (sectionLabel) {
    const sectionPath = section === 'chat' ? `${base}/bots` : `${base}/${section}`;
    out.push({ label: section === 'chat' ? 'Bots' : sectionLabel, to: tail ? sectionPath : null });
  }
  if (tail) out.push({ label: tail, to: null });
  return out;
}
