import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RunStartedPush } from '@manythreads/shared';
import { threadRunsStore } from '../../runs/store';

/** The clock, once a second, while `active`. A card of an ended run does not tick. */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * A value that changes at most once a second: the first value at once, then each later one no sooner than `gap` after the last shown (the newest one wins). The now line
 * of a busy run changes many times a second; a person reads it once a second, and a screen reader hears it once per change.
 */
export function useSteady<T>(value: T, gap = 1000): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const shownRef = useRef(value);
  useEffect(() => {
    if (Object.is(shownRef.current, value) || JSON.stringify(shownRef.current) === JSON.stringify(value)) return;
    const wait = Math.max(0, last.current + gap - Date.now());
    const t = setTimeout(() => {
      last.current = Date.now();
      shownRef.current = value;
      setShown(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, gap]);
  return shown;
}

/** The runs working on a thread root now, for its chip in the channel: known to every reader of the channel from the live pushes, open thread or not. */
export function useWorkingOn(rootId: string): readonly RunStartedPush[] {
  const subscribe = useCallback((onChange: () => void) => threadRunsStore.subscribe(rootId, onChange), [rootId]);
  return useSyncExternalStore(subscribe, () => threadRunsStore.workingOn(rootId));
}
