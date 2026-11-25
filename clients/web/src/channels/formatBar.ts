import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type RefObject } from 'react';

/*
 * Whether the formatting bar is shown above the message box. Since P37-01 it shows whenever the person is in the composer (focus anywhere inside it, the bar's
 * own buttons and the emoji picker included) or the box has text, and folds away when focus has left and the box is empty. "Show formatting" in the Attach menu
 * (P36-09) now means "keep it always shown": that choice is the same in every composer and every tab, and kept in this browser (a convenience: when storage is
 * blocked the bar is not pinned).
 */

/** The bar is drawn: pinned from the Attach menu, or the person is in the composer, or the box has text, or the emoji picker is open. */
export function formatBarVisible(w: { pinned: boolean; focusInside: boolean; hasText: boolean; emojiOpen?: boolean }): boolean {
  return w.pinned || w.focusInside || w.hasText || w.emojiOpen === true;
}

/**
 * Focus is leaving an element of the composer for `next`: does it stay "in the composer"? Yes when `next` is inside it. A press on a bar button in a browser
 * that does not focus buttons on a press (Safari) sends focus to nowhere (`next` is null) while the pointer is down inside the composer: that is not leaving.
 */
export function focusStaysInside(next: EventTarget | null, root: Element | null, pressing: boolean): boolean {
  if (next === null) return pressing;
  return next instanceof Node && root !== null && root.contains(next);
}

/** After a press inside the composer ended, is the person still in it (focus is in it)? A press that left focus on nothing means they have left. */
export function stillInside(active: Element | null, root: Element | null): boolean {
  return active !== null && root !== null && root.contains(active);
}

/** Whether focus is inside the composer element `root`, kept across focus moving between its parts (see focusStaysInside). Spread `props` on the element. */
export function useComposerFocus(root: RefObject<HTMLElement | null>): {
  inside: boolean;
  props: { onFocus: () => void; onBlur: (e: FocusEvent) => void; onPointerDown: () => void };
} {
  const [inside, setInside] = useState(false);
  const pressing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onFocus = useCallback(() => setInside(true), []);
  // a press outside the box (a message's Reply button) moves focus away on its mousedown; folding the bar then would move the list under the press, so the fold waits for the release
  const pointerDown = useRef(false);
  const foldAfterPress = useRef(false);
  const onBlur = useCallback(
    (e: FocusEvent) => {
      if (focusStaysInside(e.relatedTarget, root.current, pressing.current)) return;
      if (pointerDown.current) foldAfterPress.current = true;
      else setInside(false);
    },
    [root],
  );
  useEffect(() => {
    const down = (): void => {
      pointerDown.current = true;
    };
    const up = (): void => {
      pointerDown.current = false;
      if (!foldAfterPress.current) return;
      foldAfterPress.current = false;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (!stillInside(document.activeElement, root.current)) setInside(false);
      }, 0);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [root]);
  const onPointerDown = useCallback(() => {
    pressing.current = true;
    const end = (): void => {
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      // let the press's own click run first (it usually puts focus back in the box), then look where focus is
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        pressing.current = false;
        if (!stillInside(document.activeElement, root.current)) setInside(false);
      }, 100);
    };
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }, [root]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { inside, props: { onFocus, onBlur, onPointerDown } };
}


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

/** Another tab of this site changed the choice: this one follows it. */
const onStorage = (e: StorageEvent): void => {
  if (e.key !== KEY && e.key !== null) return;
  const next = e.key === null ? false : e.newValue === 'shown';
  if (next === formatBarShown()) return;
  shown = next;
  for (const l of [...listeners]) l();
};

const subscribe = (cb: () => void): (() => void) => {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
};

export function useFormatBar(): boolean {
  return useSyncExternalStore(subscribe, formatBarShown, () => false);
}
