/** Per-thread "Hide" of the cards, kept in the browser; a missing or blocked storage means the choice lasts until the tab closes. */
const KEY = (rootId: string): string => `mt.tv.hide.${rootId}`;
const memory = new Set<string>();

export function readHidden(rootId: string): boolean {
  if (memory.has(rootId)) return true;
  try {
    return globalThis.localStorage?.getItem(KEY(rootId)) === '1';
  } catch {
    return false;
  }
}

export function writeHidden(rootId: string, hidden: boolean): void {
  if (hidden) memory.add(rootId);
  else memory.delete(rootId);
  try {
    if (hidden) globalThis.localStorage?.setItem(KEY(rootId), '1');
    else globalThis.localStorage?.removeItem(KEY(rootId));
  } catch {
    // kept for this tab only
  }
}
