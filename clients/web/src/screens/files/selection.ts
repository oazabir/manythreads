/*
 * Which rows of the open folder are ticked (the checkboxes, Ctrl/Cmd-click, Shift-click, Shift+Arrow). Pure helpers over `{ keys, anchor }`:
 * the screen keeps the value, the list asks for the next one. Order matters only for a range, so those take the keys as the list shows them.
 */
export type Selection = { keys: ReadonlySet<string>; anchor: string | null };

export const NONE: Selection = { keys: new Set(), anchor: null };

export function toggle(sel: Selection, key: string): Selection {
  const keys = new Set(sel.keys);
  if (!keys.delete(key)) keys.add(key);
  return { keys, anchor: key };
}

/** Everything between the anchor and `key` (both included), joined to what was ticked before when `extend` is true. */
export function range(sel: Selection, ordered: readonly string[], key: string, extend = false): Selection {
  const from = sel.anchor !== null ? ordered.indexOf(sel.anchor) : -1;
  const to = ordered.indexOf(key);
  if (to < 0) return sel;
  if (from < 0) return { keys: new Set([...(extend ? sel.keys : []), key]), anchor: key };
  const [a, b] = from <= to ? [from, to] : [to, from];
  const keys = new Set(extend ? sel.keys : []);
  for (const k of ordered.slice(a, b + 1)) keys.add(k);
  return { keys, anchor: sel.anchor };
}

export function only(key: string): Selection {
  return { keys: new Set([key]), anchor: key };
}

export function all(ordered: readonly string[]): Selection {
  return { keys: new Set(ordered), anchor: ordered[0] ?? null };
}

/** Drops keys that are no longer in the folder (a file was moved, deleted, or the folder changed). */
export function prune(sel: Selection, present: readonly string[]): Selection {
  if (sel.keys.size === 0) return sel;
  const have = new Set(present);
  const keys = new Set([...sel.keys].filter((k) => have.has(k)));
  if (keys.size === sel.keys.size) return sel;
  return { keys, anchor: sel.anchor !== null && keys.has(sel.anchor) ? sel.anchor : (keys.values().next().value ?? null) };
}
