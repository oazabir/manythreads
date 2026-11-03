export type TabId = 'concepts' | 'inbox' | 'sharing';

export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'concepts', label: 'Concepts' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'sharing', label: 'Sharing' },
];

/** The tab the address asks for: a link to a concept (`?concept=`) opens the concepts, `?tab=inbox` and `?tab=sharing` open theirs, anything else the concepts. */
export function tabFromParams(tab: string | null, concept: string | null): TabId {
  return !concept && (tab === 'inbox' || tab === 'sharing') ? tab : 'concepts';
}

/** The tab a key moves to, as a tab list does: the arrows step (and wrap), Home and End jump to the first and last; any other key moves nowhere. */
export function nextTab(current: TabId, key: string): TabId | null {
  const at = TABS.findIndex((t) => t.id === current);
  const to = key === 'ArrowRight' ? (at + 1) % TABS.length : key === 'ArrowLeft' ? (at + TABS.length - 1) % TABS.length : key === 'Home' ? 0 : key === 'End' ? TABS.length - 1 : -1;
  return TABS[to]?.id ?? null;
}
