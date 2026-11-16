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

/** Whether the dock above a thread's composer is folded to one line: remembered per thread; `null` when the person never chose (the screen's width decides). */
const DOCK_KEY = (rootId: string): string => `mt.tv.dock.${rootId}`;
const dockMemory = new Map<string, boolean>();

export function readDockFolded(rootId: string): boolean | null {
  const m = dockMemory.get(rootId);
  if (m !== undefined) return m;
  try {
    const v = globalThis.localStorage?.getItem(DOCK_KEY(rootId));
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

export function writeDockFolded(rootId: string, folded: boolean): void {
  dockMemory.set(rootId, folded);
  try {
    globalThis.localStorage?.setItem(DOCK_KEY(rootId), folded ? '1' : '0');
  } catch {
    // kept for this tab only
  }
}

/** For tests. */
export function forgetDockFolded(): void {
  dockMemory.clear();
}
