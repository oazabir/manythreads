export type TabId = 'concepts' | 'inbox' | 'sharing';
type Tab = { id: TabId; label: string };

export const TABS: ReadonlyArray<Tab> = [
  { id: 'concepts', label: 'Concepts' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'sharing', label: 'Sharing' },
];

/** A person's own memory is never shared, so it has no Sharing tab; its first tab holds files rather than concepts a team confirms. */
export const PERSONAL_TABS: ReadonlyArray<Tab> = [
  { id: 'concepts', label: 'Memory' },
  { id: 'inbox', label: 'Inbox' },
];

/** The tab the address asks for: a link to a concept (`?concept=`) opens the concepts, `?tab=inbox` and `?tab=sharing` open theirs, anything else the concepts. Personal has no sharing tab. */
export function tabFromParams(tab: string | null, concept: string | null, tabs: ReadonlyArray<Tab> = TABS): TabId {
  return !concept && tabs.some((t) => t.id === tab) && (tab === 'inbox' || tab === 'sharing') ? (tab as TabId) : 'concepts';
}

/** The tab a key moves to, as a tab list does: the arrows step (and wrap), Home and End jump to the first and last; any other key moves nowhere. */
export function nextTab(current: TabId, key: string, tabs: ReadonlyArray<Tab> = TABS): TabId | null {
  const at = tabs.findIndex((t) => t.id === current);
  const to = key === 'ArrowRight' ? (at + 1) % tabs.length : key === 'ArrowLeft' ? (at + tabs.length - 1) % tabs.length : key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : -1;
  return tabs[to]?.id ?? null;
}
