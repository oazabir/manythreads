/*
 * The three reactions a person used last (P21-02): the hover bar of a message shows them as one-click buttons. Kept in this browser only.
 */

const KEY = 'mt:recent-reactions';
export const DEFAULT_REACTIONS: readonly string[] = ['👍', '✅', '👀'];
const SIZE = 3;

/** The list after `emoji` was used: it goes first, the others keep their order, and the list stays three long (the defaults fill what is missing). */
export function pushReaction(list: readonly string[], emoji: string): string[] {
  const used = [emoji, ...list.filter((e) => e !== emoji)];
  for (const d of DEFAULT_REACTIONS) if (used.length < SIZE && !used.includes(d)) used.push(d);
  return used.slice(0, SIZE);
}

/** The stored list, or the defaults when nothing usable is stored. */
export function parseReactions(raw: string | null): string[] {
  try {
    const v: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(v)) {
      const ok = v.filter((e): e is string => typeof e === 'string' && e !== '' && e.length <= 64);
      if (ok.length > 0) return fill([...new Set(ok)]);
    }
  } catch {
    // a broken value is ignored
  }
  return [...DEFAULT_REACTIONS];
}

function fill(list: string[]): string[] {
  const out = list.slice(0, SIZE);
  for (const d of DEFAULT_REACTIONS) if (out.length < SIZE && !out.includes(d)) out.push(d);
  return out;
}

export function loadReactions(): string[] {
  try {
    return parseReactions(localStorage.getItem(KEY));
  } catch {
    return [...DEFAULT_REACTIONS];
  }
}

export function rememberReaction(emoji: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pushReaction(loadReactions(), emoji)));
  } catch {
    // storage may be blocked; the bar then keeps the defaults
  }
}
