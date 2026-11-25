import type { ChannelKind } from '@manythreads/shared';

/*
 * The threads this person opened lately (P37-09), kept in this browser, per person and per team, like the places in recentPlaces.ts. Summaries shows the last ten at its
 * foot. Only a snapshot is kept (the root's id, where it lives, its title and when it was opened); nothing is fetched for a row, so a thread that was deleted meanwhile
 * still has its row, and a press on it shows the normal "This thread is not available".
 */

export const MAX_RECENT_THREADS = 10;
const TITLE_MAX = 140;
const storageKey = (personId: string, teamSlug: string): string => `manythreads.recentThreads.${personId}.${teamSlug}`;

export interface RecentThread {
  /** The root message's id: the thread's own id. */
  rootId: string;
  channelId: string;
  channelKind: ChannelKind;
  /** The channel's name without `#`; empty for a direct message. */
  channelName: string;
  /** The thread's title, or the first line of its root message, as it was when opened. */
  title: string;
  /** When it was opened (ISO time). */
  at: string;
}

/** The first line of a message as a title: one line, spaces folded, cut with an ellipsis. */
export function titleLine(text: string, max: number = TITLE_MAX): string {
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Pure: puts `entry` first, drops an earlier copy of the same thread, keeps the newest ten. */
export const pushRecentThread = (list: readonly RecentThread[], entry: RecentThread): RecentThread[] =>
  [entry, ...list.filter((e) => e.rootId !== entry.rootId)].slice(0, MAX_RECENT_THREADS);

/** Pure: what a stored value holds, kept only where it is whole (a damaged entry is dropped), without repeats, newest first, at most ten. */
export function parseRecentThreads(raw: unknown): RecentThread[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentThread[] = [];
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.rootId !== 'string' || e.rootId === '' || typeof e.channelId !== 'string' || typeof e.channelKind !== 'string' || typeof e.at !== 'string') continue;
    if (Number.isNaN(Date.parse(e.at)) || seen.has(e.rootId)) continue;
    seen.add(e.rootId);
    out.push({
      rootId: e.rootId,
      channelId: e.channelId,
      channelKind: e.channelKind as ChannelKind,
      channelName: typeof e.channelName === 'string' ? e.channelName : '',
      title: typeof e.title === 'string' ? e.title.slice(0, TITLE_MAX) : '',
      at: e.at,
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_RECENT_THREADS);
}

/** The threads this person opened last in this team, newest first. Browser-only; blocked storage reads as none. */
export function readRecentThreads(personId: string, teamSlug: string): RecentThread[] {
  try {
    return parseRecentThreads(JSON.parse(localStorage.getItem(storageKey(personId, teamSlug)) ?? '[]'));
  } catch {
    return [];
  }
}

export function recordRecentThread(personId: string, teamSlug: string, entry: RecentThread): void {
  try {
    localStorage.setItem(storageKey(personId, teamSlug), JSON.stringify(pushRecentThread(readRecentThreads(personId, teamSlug), entry)));
  } catch {
    /* private mode or a full store: the list is only a convenience */
  }
}
