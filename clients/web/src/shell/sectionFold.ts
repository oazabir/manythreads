import { useCallback, useState } from 'react';

/*
 * Whether a sidebar section (Direct messages, Bots) is folded (P21-08). Kept per person and team in this browser; a saved copy on the server
 * (`sidebar_prefs.collapsed`, so a second device agrees) needs a migration and a route change that is not part of this client step.
 * `!id` marks a section the person opened on purpose, so a "starts folded" default (Bots with more than five bots) no longer applies.
 */

export type FoldId = 'dm' | 'bots';
export type FoldState = readonly string[];

const KEY = (personId: string, slug: string): string => `mt.sidebar.fold:${personId}:${slug}`;

export function readFold(personId: string, slug: string): FoldState {
  try {
    const raw = localStorage.getItem(KEY(personId, slug));
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeFold(personId: string, slug: string, state: FoldState): void {
  try {
    localStorage.setItem(KEY(personId, slug), JSON.stringify(state));
  } catch {
    // private window or blocked storage: the fold lasts until reload
  }
}

/** Folded now? An explicit choice wins; otherwise `startFolded` decides. */
export function isFolded(state: FoldState, id: FoldId, startFolded = false): boolean {
  if (state.includes(id)) return true;
  if (state.includes(`!${id}`)) return false;
  return startFolded;
}

/** The state after the person folds or opens `id`. */
export function toggleFold(state: FoldState, id: FoldId, startFolded = false): FoldState {
  const rest = state.filter((x) => x !== id && x !== `!${id}`);
  return isFolded(state, id, startFolded) ? [...rest, `!${id}`] : [...rest, id];
}

export function useFold(personId: string, slug: string, id: FoldId, startFolded = false): [boolean, () => void] {
  // the saved state belongs to one person and team: when the team changes the other team's fold is read, never written over
  const scope = `${personId}:${slug}`;
  const [held, setHeld] = useState<{ scope: string; state: FoldState }>(() => ({ scope, state: readFold(personId, slug) }));
  const state = held.scope === scope ? held.state : readFold(personId, slug);
  const toggle = useCallback(() => {
    const next = toggleFold(readFold(personId, slug), id, startFolded);
    writeFold(personId, slug, next);
    setHeld({ scope: `${personId}:${slug}`, state: next });
  }, [personId, slug, id, startFolded]);
  return [isFolded(state, id, startFolded), toggle];
}
