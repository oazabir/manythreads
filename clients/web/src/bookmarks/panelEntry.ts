import { writePanel, type PanelEntry } from '../kernel/panel';
import { tabFrom, type BookmarkTabId } from './model';

/*
 * The Bookmarks panel (P37-08, owner 2026-11-25): the Bookmarks button at the top right toggles a right-hand panel with the person's bookmarks. It is an
 * ordinary entry of the right panel's stack, `?panel=bookmarks:<tab>` (the id is the tab on show), so a reload or a pasted link restores it and Back works.
 * Pure rules here, so they are tested without a browser.
 */

export const BOOKMARKS_PANEL = 'bookmarks';

export const bookmarksEntry = (tab: BookmarkTabId = 'thread'): PanelEntry => ({ type: BOOKMARKS_PANEL, id: tab });

/** The tab an entry shows (anything unknown is the first tab). */
export const bookmarksTabOf = (entry: PanelEntry): BookmarkTabId => tabFrom(entry.id);

/** Whether the Bookmarks panel is the one on screen: the button reads as pressed only then. */
export const bookmarksOpen = (entries: readonly PanelEntry[]): boolean => entries.at(-1)?.type === BOOKMARKS_PANEL;

/**
 * What a press of the button does. Closed (or something else on top, even a thread opened from a bookmark): show the panel on top, so Back returns to what was there.
 * Open: take it away again, which shows what was under it, or closes the panel when it was alone.
 */
export function bookmarksPress(entries: readonly PanelEntry[]): 'open' | 'back' | 'close' {
  if (!bookmarksOpen(entries)) return 'open';
  return entries.length > 1 ? 'back' : 'close';
}

/**
 * An address (a file of the team's repository or Personal) with the panel kept beside it, so the list stays while the person goes through several. `to` may
 * already have a query string.
 */
export function withPanel(to: string, stack: readonly PanelEntry[]): { pathname: string; search: string; state: unknown } {
  const i = to.indexOf('?');
  const pathname = i < 0 ? to : to.slice(0, i);
  const next = writePanel({ search: i < 0 ? '' : to.slice(i), state: null }, stack, false);
  return { pathname, search: next.search, state: next.state };
}
