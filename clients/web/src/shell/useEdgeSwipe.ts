import { useEffect, useRef } from 'react';

/** A finger that starts this close to the left edge (px) may be opening the drawer; anywhere else it is a scroll or a tap. */
export const EDGE_ZONE = 24;
/** How far right (px) the finger must travel to open it. */
export const SWIPE_MIN_DX = 60;
/** Up or down drift (px) that turns the gesture into a scroll: the list wins, the drawer stays shut. */
export const SWIPE_MAX_DY = 30;

export interface EdgeSwipe {
  start(x: number, y: number): void;
  /** Feeds one finger position; true exactly once, when the swipe is far enough and straight enough. */
  move(x: number, y: number): boolean;
  /** The finger lifted, was cancelled, or a second finger came down. */
  cancel(): void;
}

/**
 * The drawer gesture without the browser: a swipe from the left edge (start within `EDGE_ZONE`, travel `SWIPE_MIN_DX` or more to the right while
 * drifting less than `SWIPE_MAX_DY` up or down). Once the finger has drifted too far, or moved back to the left, the gesture is dead until the next
 * touch, so scrolling a list from the edge never opens the drawer half-way through.
 */
export function createEdgeSwipe(): EdgeSwipe {
  let from: { x: number; y: number } | null = null;
  return {
    start(x, y) {
      from = x >= 0 && x <= EDGE_ZONE ? { x, y } : null;
    },
    move(x, y) {
      if (!from) return false;
      const dx = x - from.x;
      const dy = Math.abs(y - from.y);
      if (dy >= SWIPE_MAX_DY || dx < -10) {
        from = null;
        return false;
      }
      if (dx >= SWIPE_MIN_DX) {
        from = null;
        return true;
      }
      return false;
    },
    cancel() {
      from = null;
    },
  };
}

/**
 * Calls `onOpen` when the person swipes in from the left edge. The listeners are passive and never stop the event, so scrolling and text selection
 * behave as they do without the hook; `enabled` is false on a wide screen and while the drawer is already open.
 *
 * A touch that starts on a scrolling list is taken over by the browser after its first move (it may be a scroll, or the browser's own back swipe), and
 * the page then hears nothing more of it. So the shell draws a thin strip along the left edge (`.edge-zone`, `touch-action: pan-y`) for this hook:
 * the browser keeps its hands off a sideways move there, and every move reaches the listeners.
 */
export function useEdgeSwipe(enabled: boolean, onOpen: () => void): void {
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  });
  useEffect(() => {
    if (!enabled) return;
    const swipe = createEdgeSwipe();
    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t) return swipe.cancel();
      swipe.start(t.clientX, t.clientY);
    };
    const onMove = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t) return;
      if (e.touches.length !== 1) return swipe.cancel();
      if (swipe.move(t.clientX, t.clientY)) open.current();
    };
    const onEnd = (): void => swipe.cancel();
    const opts = { passive: true } as const;
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMove, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled]);
}
