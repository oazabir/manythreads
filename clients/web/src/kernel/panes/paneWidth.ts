import { useCallback, useSyncExternalStore } from 'react';

/*
 * The widths of the site's side-by-side panes (owner, 2026-11-21: "add resizers in all such panes throughout the site"): the sidebar, the list beside a thread
 * (Threads, Later, Approvals, a bot's conversations), the thread's side rail, the Chat history, the Files tree, the board's card panel and the settings menu.
 * The person drags the bar on the pane's edge (or uses the arrow keys, Home for the least width and End for the most; a double click restores the default). Each width is kept per device under its own key;
 * a blocked storage keeps it until the page closes. The right panel keeps its own width (kernel/panel/panelSize.ts).
 *
 * A stored width is only what the person asked for: the stylesheet also caps it against the room the pane's neighbour needs (`min(var(--…), calc(100% - …))`),
 * so a narrower window never squeezes the content beside a wide pane. The limits here are the pane's own.
 */

export interface PaneSpec {
  /** The storage key's last part and the CSS variable's name (`--pane-<id>`). */
  id: string;
  label: string;
  def: number;
  min: number;
  max: number;
  /** The least the content beside the pane keeps while it is dragged, in px. */
  rest: number;
}

export const PANES = {
  sidebar: { id: 'sidebar', label: 'Resize sidebar', def: 248, min: 200, max: 440, rest: 360 },
  list: { id: 'list', label: 'Resize list', def: 420, min: 340, max: 720, rest: 360 },
  threadRail: { id: 'thread-rail', label: 'Resize thread overview', def: 300, min: 240, max: 560, rest: 360 },
  chatHistory: { id: 'chat-history', label: 'Resize chat history', def: 280, min: 200, max: 480, rest: 360 },
  filesTree: { id: 'files-tree', label: 'Resize folder tree', def: 225, min: 160, max: 520, rest: 360 },
  boardPanel: { id: 'board-panel', label: 'Resize card panel', def: 340, min: 280, max: 720, rest: 320 },
  settingsNav: { id: 'settings-nav', label: 'Resize settings menu', def: 214, min: 180, max: 380, rest: 360 },
} as const satisfies Record<string, PaneSpec>;

export const PANE_STEP = 16;

const key = (id: string): string => `manythreads.pane-width.${id}`;
const cssVar = (id: string): string => `--pane-${id}`;

/** A width within the pane's own limits; anything that is not a number gives the default. */
export const clampPane = (spec: PaneSpec, width: number): number => {
  const w = Number.isFinite(width) ? Math.round(width) : spec.def;
  return Math.min(spec.max, Math.max(spec.min, w));
};

/**
 * The width a drag asks for, the pointer at `clientX`: a pane whose bar is on its end edge grows to the right from its start (`left`), one whose bar is on
 * its start edge grows to the left from its end (`right`). `room` is what the pane's container is wide: the neighbour keeps `spec.rest` of it.
 */
export function widthForPointer(spec: PaneSpec, edge: 'start' | 'end', clientX: number, rect: { left: number; right: number }, room: number): number {
  const asked = edge === 'end' ? clientX - rect.left : rect.right - clientX;
  const roomMax = Math.max(spec.min, room - spec.rest);
  return Math.min(roomMax, clampPane(spec, asked));
}

const widths = new Map<string, number | null>();
const listeners = new Set<() => void>();
/** The width reaches the stylesheet as a variable on the page's root, so a drag changes one style and re-renders nothing but the bar. */
const apply = (spec: PaneSpec): void => {
  const w = widths.get(spec.id) ?? null;
  const root = typeof document === 'undefined' ? null : document.documentElement;
  if (!root) return;
  if (w === null) root.style.removeProperty(cssVar(spec.id));
  else root.style.setProperty(cssVar(spec.id), `${w}px`);
};
const notify = (spec: PaneSpec): void => {
  apply(spec);
  for (const l of listeners) l();
};

function stored(spec: PaneSpec): number {
  if (!widths.has(spec.id)) {
    let n: number | null = null;
    try {
      const raw = window.localStorage.getItem(key(spec.id));
      const v = raw === null ? NaN : Number(raw);
      n = Number.isFinite(v) ? clampPane(spec, v) : null;
    } catch {
      n = null;
    }
    widths.set(spec.id, n);
  }
  return widths.get(spec.id) ?? spec.def;
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Hands every kept width to the stylesheet; called once when the app starts. */
export function applyPaneWidths(): void {
  for (const spec of Object.values(PANES)) {
    stored(spec);
    apply(spec);
  }
}

/** Forget what this tab read (tests). */
export function forgetPaneWidths(): void {
  for (const spec of Object.values(PANES)) {
    widths.set(spec.id, null);
    notify(spec);
  }
  widths.clear();
}

export interface PaneWidth {
  width: number;
  /** Shows a width at once (during a drag). */
  set: (w: number) => void;
  /** Shows and keeps a width (the end of a drag, a key press). */
  keep: (w: number) => void;
  restoreDefault: () => void;
}

export function usePaneWidth(spec: PaneSpec): PaneWidth {
  const width = useSyncExternalStore(subscribe, () => stored(spec), () => spec.def);
  const set = useCallback((w: number) => {
    widths.set(spec.id, clampPane(spec, w));
    notify(spec);
  }, [spec]);
  const keep = useCallback((w: number) => {
    const v = clampPane(spec, w);
    widths.set(spec.id, v);
    try {
      window.localStorage.setItem(key(spec.id), String(v));
    } catch {
      // storage may be blocked (a private window): the width then lasts until the page is closed
    }
    notify(spec);
  }, [spec]);
  const restoreDefault = useCallback(() => {
    widths.set(spec.id, null);
    try {
      window.localStorage.removeItem(key(spec.id));
    } catch {
      // nothing kept, nothing to forget
    }
    notify(spec);
  }, [spec]);
  return { width, set, keep, restoreDefault };
}
