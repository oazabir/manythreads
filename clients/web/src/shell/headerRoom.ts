import { useLayoutEffect, useState } from 'react';

/*
 * How much room the channel header has (P33-01). The right panel narrows the header without the window changing, and the person can drag the panel wider, so neither a
 * media query nor the window's width can say: the header's own width does.
 */

/** A header at least this wide has the search as a bar; narrower, the search is the magnifier. */
export const SEARCH_BAR_MIN_HEADER = 800;
/** A header narrower than this (a right panel open on a small screen) keeps only the buttons that matter: Bot Board and Schedule a room are in the details menu. */
export const TIGHT_HEADER_MAX = 560;

/** The room a header of this width has: `bar` (a search bar fits), `icons` (the buttons fit, the search is a magnifier) or `tight`. */
export const headerRoom = (width: number | null): 'bar' | 'icons' | 'tight' => (width === null || width >= SEARCH_BAR_MIN_HEADER ? 'bar' : width >= TIGHT_HEADER_MAX ? 'icons' : 'tight');

/** The width of this element, kept up to date (null until measured, and with no element). */
export function useElementWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const read = (): void => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}
