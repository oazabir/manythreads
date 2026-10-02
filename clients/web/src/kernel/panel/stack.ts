/*
 * The right panel's stack as pure data (PLAN P3-11, SPEC section 3 "right panel with a back stack").
 *
 * The URL is the source of truth for what is open: `?panel=<type>:<id>` names the TOP entry, so a reload or a pasted link
 * restores it. The entries underneath ride in the history entry's `state` (`state.panel`), so a reload of the same
 * history entry also restores a sensible back history; a link opened in a new tab has only the top entry.
 * Nothing here touches the DOM or the router.
 */

export type PanelEntry = { readonly type: string; readonly id: string };

/** A location as the router sees it: the query string and the history entry's state. */
export type PanelLocation = { readonly search: string; readonly state: unknown };

/** What the panel needs from the browser history. The router backs it in the app; a list of entries backs it in tests. */
export interface PanelHistory {
  read(): PanelLocation;
  push(next: PanelLocation): void;
  replace(next: PanelLocation): void;
  /** One step back in the browser history. */
  back(): void;
}

export const PANEL_PARAM = 'panel';
/** Deepest back history kept; older entries fall off the bottom. */
export const MAX_STACK = 20;

const TYPE = /^[a-z][a-z0-9-]*$/;
const MAX_ID = 300;

export const formatEntry = (e: PanelEntry): string => `${e.type}:${e.id}`;
export const sameEntry = (a: PanelEntry, b: PanelEntry): boolean => a.type === b.type && a.id === b.id;

/** `thread:0192..` to an entry; the id is everything after the first colon (a file path may hold more). */
export function parseEntry(raw: string | null | undefined): PanelEntry | null {
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i < 1) return null;
  const type = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!TYPE.test(type) || id.length === 0 || id.length > MAX_ID) return null;
  return { type, id };
}

type StoredPanel = { stack: string[]; viaPush: boolean };

function storedPanel(state: unknown): StoredPanel | null {
  if (typeof state !== 'object' || state === null) return null;
  const p = (state as { panel?: unknown }).panel;
  if (typeof p !== 'object' || p === null) return null;
  const { stack, viaPush } = p as { stack?: unknown; viaPush?: unknown };
  if (!Array.isArray(stack) || !stack.every((s) => typeof s === 'string')) return null;
  return { stack: stack as string[], viaPush: viaPush === true };
}

export type PanelState = {
  /** Oldest first; the last entry is the one on screen. Empty when the panel is closed. */
  stack: PanelEntry[];
  /** True when the history entry just before this one is this stack without its top, so Back can use the browser. */
  viaPush: boolean;
};

export function readPanel(loc: PanelLocation): PanelState {
  const top = parseEntry(new URLSearchParams(loc.search).get(PANEL_PARAM));
  if (!top) return { stack: [], viaPush: false };
  const stored = storedPanel(loc.state);
  if (stored) {
    const entries = stored.stack.map(parseEntry);
    const last = entries[entries.length - 1];
    if (entries.length > 0 && entries.every((e): e is PanelEntry => e !== null) && last && sameEntry(last, top)) {
      return { stack: entries.slice(-MAX_STACK), viaPush: stored.viaPush };
    }
  }
  // a pasted link, or state that no longer matches the URL: just the entry the URL names
  return { stack: [top], viaPush: false };
}

/** The location with the panel set to `stack` (or closed when empty). Other query parameters and state are kept. */
export function writePanel(loc: PanelLocation, stack: readonly PanelEntry[], viaPush: boolean): PanelLocation {
  const params = new URLSearchParams(loc.search);
  const rest = typeof loc.state === 'object' && loc.state !== null ? { ...(loc.state as Record<string, unknown>) } : {};
  delete rest['panel'];
  const kept = stack.slice(-MAX_STACK);
  const top = kept[kept.length - 1];
  if (top) {
    params.set(PANEL_PARAM, formatEntry(top));
    rest['panel'] = { stack: kept.map(formatEntry), viaPush } satisfies StoredPanel;
  } else {
    params.delete(PANEL_PARAM);
  }
  const q = params.toString();
  return { search: q ? `?${q}` : '', state: Object.keys(rest).length > 0 ? rest : null };
}
