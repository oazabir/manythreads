/*
 * The way back in the header band (P34-06). A top-level screen (Threads, Messages, Search, Chat, Activity, Files, Boards, Approvals, …) has no trail:
 * the band is its title and its tools, like a channel's (owner, 2026-11-19; it reverses P21-12's "Engineering / Boards"). A screen one step inside a
 * section that has a list of its own (a bot's page under Bots, one proposal, one project) keeps one link back to that list, before its title.
 */

export interface HeaderBack {
  /** what the link says: the list it goes back to */
  label: string;
  to: string;
}

/** The sections whose items open a screen of their own, and the list each goes back to. `/t/<team>/chat/<id>` is one bot conversation, under Bots. */
const PARENT: Record<string, { label: string; section: string }> = {
  bots: { label: 'Bots', section: 'bots' },
  chat: { label: 'Bots', section: 'bots' },
  projects: { label: 'Projects', section: 'projects' },
  proposals: { label: 'Proposals', section: 'proposals' },
};

/** The link back for this address, or null on a top-level screen (and outside a team). */
export function headerBackFor(pathname: string): HeaderBack | null {
  const m = /^\/t\/([^/]+)\/([^/]+)\/[^/]+/.exec(pathname);
  if (!m) return null;
  const [, slug = '', section = ''] = m;
  const parent = PARENT[section];
  return parent ? { label: parent.label, to: `/t/${slug}/${parent.section}` } : null;
}
