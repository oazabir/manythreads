import { useSyncExternalStore } from 'react';

/**
 * No pointer that can hover at all (a phone, a tablet used by finger): nothing may wait for a hover. `any-hover`, not `pointer`: a tablet with a trackpad
 * or a mouse still reports a coarse primary pointer, and without the hover bar its person could not reach the row's actions (P34-05 review).
 */
export const COARSE_QUERY = '(any-hover: none)';

const subscribe = (cb: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia(COARSE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const snapshot = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;

export const useCoarsePointer = (): boolean => useSyncExternalStore(subscribe, snapshot, () => false);
