import { useSyncExternalStore } from 'react';

/** The phone layout starts here: the sidebar becomes a drawer and the right panel a full-height sheet (styles/shell.css). */
export const NARROW_QUERY = '(width <= 760px)';

const subscribe = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const snapshot = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;

export const useNarrow = (): boolean => useSyncExternalStore(subscribe, snapshot, () => false);
