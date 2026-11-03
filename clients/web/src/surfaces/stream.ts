import { createSurfaceStreamState, endSurface, feedSurface, type SurfaceStreamState } from '@manythreads/shared';

// Keeps the checker's state in step with a text that only grows (PLAN P9-03). The page hands over the whole text so far each time; this feeds the checker only
// the part it has not seen, so a surface that arrives in a thousand pieces is read once, not a thousand times.

export interface SurfaceFeed {
  state: SurfaceStreamState;
  /** The text the state has been given so far. */
  fed: string;
}

/** How much of the end of the fed text is compared with the new text to tell "more text arrived" from "a different text". */
const TAIL = 64;

export function startSurfaceFeed(): SurfaceFeed {
  return { state: createSurfaceStreamState(), fed: '' };
}

/**
 * The feed after `source` (the whole text so far). If `source` goes on from what was fed, only the new tail is read; if it is a different text (a patched
 * surface, another surface), reading starts again from the top. `ended` closes the text: nothing more will come.
 */
export function advanceSurfaceFeed(prev: SurfaceFeed | null, source: string, ended: boolean): SurfaceFeed {
  let feed = prev;
  if (feed !== null) {
    const keep = Math.max(0, feed.fed.length - TAIL);
    const continues = source.length >= feed.fed.length && source.startsWith(feed.fed.slice(keep), keep);
    if (!continues || (feed.state.ended && source.length !== feed.fed.length)) feed = null;
  }
  const base = feed ?? startSurfaceFeed();
  let state = base.state;
  if (source.length > base.fed.length) state = feedSurface(state, source.slice(base.fed.length));
  if (ended) state = endSurface(state);
  if (state === base.state && source.length === base.fed.length && feed !== null) return feed;
  return { state, fed: source };
}
