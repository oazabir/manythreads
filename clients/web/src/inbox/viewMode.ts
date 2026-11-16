/** How the Threads view is laid out: a list with the thread beside it, or a grid of cards. Remembered per person in this browser; a blocked storage means "list". */
export type ThreadsLayout = 'list' | 'grid';

const KEY = (personId: string | undefined): string => `mt.threads.layout.${personId ?? 'me'}`;
const memory = new Map<string, ThreadsLayout>();

export function readLayout(personId: string | undefined): ThreadsLayout {
  const k = KEY(personId);
  const m = memory.get(k);
  if (m) return m;
  try {
    return globalThis.localStorage?.getItem(k) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function writeLayout(personId: string | undefined, layout: ThreadsLayout): void {
  const k = KEY(personId);
  memory.set(k, layout);
  try {
    globalThis.localStorage?.setItem(k, layout);
  } catch {
    // kept for this tab only
  }
}

export function forgetLayout(): void {
  memory.clear();
}
