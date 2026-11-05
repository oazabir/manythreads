import { useCallback, useState } from 'react';

/*
 * How wide the right panel is. The person drags the bar on its left edge (or uses the arrow keys); the width is kept per device. The limits are pure
 * functions so they can be tested without a browser: the panel never gets narrower than MIN, and the channel beside it never narrower than CENTER_MIN.
 */

export const PANEL_DEFAULT = 380;
export const PANEL_MIN = 320;
export const PANEL_STEP = 16;
/** The rail's width (styles/shell.css) and the least the channel keeps beside a resized panel. */
export const RAIL_WIDTH = 248;
export const CENTER_MIN = 320;
/** The phone layout (sidebar as a drawer, panel as a full-height sheet) holds up to this width. The media queries in styles/shell.css repeat the number. */
export const PHONE_MAX = 760;
/** Narrower than this a thread no longer fits beside the channel: rail + the least the channel keeps + the least a panel gets. */
export const SIDE_BY_SIDE_MIN = RAIL_WIDTH + CENTER_MIN + PANEL_MIN;

export type ThreadLayout = 'side' | 'fill' | 'sheet';

/**
 * Where a panel entry is drawn for this window (never stored, so it follows the window both ways): a phone gets the sheet; a thread fills the area
 * beside the rail when the person expanded it or the window is too narrow to hold it beside the channel; everything else sits at the side.
 */
export function threadLayout(a: { viewport: number; narrow: boolean; isThread: boolean; expanded: boolean }): ThreadLayout {
  if (a.narrow) return 'sheet';
  if (a.isThread && (a.expanded || a.viewport < SIDE_BY_SIDE_MIN)) return 'fill';
  return 'side';
}

const KEY = 'manythreads.panel-width';

/** The widest the panel may be in a window `viewport` px wide. Never below MIN, so a small window still gets a usable panel. */
export const maxPanelWidth = (viewport: number): number => Math.max(PANEL_MIN, viewport - RAIL_WIDTH - CENTER_MIN);

export const clampPanelWidth = (width: number, viewport: number): number => {
  const w = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT;
  return Math.min(maxPanelWidth(viewport), Math.max(PANEL_MIN, w));
};

/** The width for a drag whose pointer is at `clientX`: the panel's right edge is the window's right edge. */
export const widthFromPointer = (clientX: number, viewport: number): number => clampPanelWidth(viewport - clientX, viewport);

const read = (): number | null => {
  try {
    const raw = window.localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};
const write = (width: number): void => {
  try {
    window.localStorage.setItem(KEY, String(width));
  } catch {
    // storage may be blocked (a private window): the width then lasts until the page is closed
  }
};
const reset = (): void => {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing kept, nothing to forget
  }
};

/** The panel's width, how to change it, and how to keep it. `set` shows a width at once; `keep` stores it (end of a drag, a key press). */
export function usePanelWidth(): { width: number; set: (w: number) => void; keep: (w: number) => void; restoreDefault: () => void } {
  const [width, setWidth] = useState<number>(() => (typeof window === 'undefined' ? PANEL_DEFAULT : (read() ?? PANEL_DEFAULT)));
  const set = useCallback((w: number) => setWidth(w), []);
  const keep = useCallback((w: number) => {
    setWidth(w);
    write(w);
  }, []);
  const restoreDefault = useCallback(() => {
    setWidth(PANEL_DEFAULT);
    reset();
  }, []);
  return { width, set, keep, restoreDefault };
}
