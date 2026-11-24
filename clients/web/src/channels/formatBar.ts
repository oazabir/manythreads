import { useSyncExternalStore } from 'react';

/*
 * Whether the formatting bar is shown above the message box (P36-09). It is hidden unless the person asks for it with "Show formatting" in the Attach menu;
 * the choice is the same in every composer and kept in this browser (a convenience: when storage is blocked the bar starts hidden).
 */

const KEY = 'manythreads.composer.formatBar';
const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === 'shown';
  } catch {
    return false;
  }
};

let shown: boolean | null = null;

export function formatBarShown(): boolean {
  if (shown === null) shown = typeof window === 'undefined' ? false : read();
  return shown;
}

export function setFormatBarShown(next: boolean): void {
  shown = next;
  try {
    if (next) window.localStorage.setItem(KEY, 'shown');
    else window.localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the choice lasts until the page is reloaded
  }
  for (const l of [...listeners]) l();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useFormatBar(): boolean {
  return useSyncExternalStore(subscribe, formatBarShown, () => false);
}
