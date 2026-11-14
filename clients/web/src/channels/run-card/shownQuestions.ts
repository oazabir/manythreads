import { useCallback, useSyncExternalStore } from 'react';

/*
 * Which of a thread's questions a run card is showing right now (PLAN P25-11). A question is asked in one place: the thread's approvals strip leaves out exactly the ones a
 * card has drawn, never more, so a question the card could not load (an error, still loading) stays answerable in the strip.
 * Also carries a card's focus and open state over to the folded line that takes its place when the run ends.
 */

const shown = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: ReadonlySet<string> = new Set();

function emit(rootId: string): void {
  for (const l of [...(listeners.get(rootId) ?? [])]) l();
}

/** A card says which questions it draws (an empty list when it draws none). */
export function setShownQuestions(rootId: string, runId: string, ids: readonly string[]): void {
  const key = `${rootId}\u0000${runId}`;
  const before = shown.get(key) ?? EMPTY;
  if (before.size === ids.length && ids.every((id) => before.has(id))) return;
  if (ids.length === 0) shown.delete(key);
  else shown.set(key, new Set(ids));
  emit(rootId);
}

/** Every question the thread's run cards draw, as one set (a new object only when it changes). */
const cache = new Map<string, ReadonlySet<string>>();
export const shownNow = (rootId: string): ReadonlySet<string> => shownIn(rootId);
function shownIn(rootId: string): ReadonlySet<string> {
  const all = new Set<string>();
  for (const [key, ids] of shown) if (key.startsWith(`${rootId}\u0000`)) for (const id of ids) all.add(id);
  const prior = cache.get(rootId);
  if (prior && prior.size === all.size && [...all].every((id) => prior.has(id))) return prior;
  cache.set(rootId, all);
  return all;
}

export function useShownQuestions(rootId: string): ReadonlySet<string> {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(rootId) ?? new Set();
      set.add(onChange);
      listeners.set(rootId, set);
      return () => set.delete(onChange);
    },
    [rootId],
  );
  return useSyncExternalStore(subscribe, () => shownIn(rootId), () => EMPTY);
}

/** What a live card leaves to the folded line of the same run: whether it held the focus and whether its step list was open. Read once. */
const handoffs = new Map<string, { focus: boolean; open: boolean; at: number }>();
export const leaveHandoff = (runId: string, h: { focus: boolean; open: boolean }): void => void handoffs.set(runId, { ...h, at: Date.now() });
/** Only a line that takes the card's place at once takes what it left: a card that went away with its panel must not pull the focus when the thread is opened again later. */
export function takeHandoff(runId: string): { focus: boolean; open: boolean } | undefined {
  const h = handoffs.get(runId);
  handoffs.delete(runId);
  return h !== undefined && Date.now() - h.at < 5_000 ? { focus: h.focus, open: h.open } : undefined;
}

/** For tests. */
export function forgetShownQuestions(): void {
  shown.clear();
  cache.clear();
  handoffs.clear();
}
