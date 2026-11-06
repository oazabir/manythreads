const MAX_RECENT = 8;
const storageKey = (personId: string, teamSlug: string): string => `manythreads.recent.${personId}.${teamSlug}`;

/** Pure: puts `key` first, drops an earlier copy, keeps the newest eight. */
export const pushRecent = (list: readonly string[], key: string): string[] => [key, ...list.filter((k) => k !== key)].slice(0, MAX_RECENT);

/** The switcher keys (`channel:<id>`, `dm:<id>`, ...) of the places this person visited last in this team, newest first. Browser-only. */
export function readRecent(personId: string, teamSlug: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey(personId, teamSlug)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function recordRecent(personId: string, teamSlug: string, key: string): void {
  try {
    localStorage.setItem(storageKey(personId, teamSlug), JSON.stringify(pushRecent(readRecent(personId, teamSlug), key)));
  } catch {
    /* private mode: the list is only a convenience */
  }
}
