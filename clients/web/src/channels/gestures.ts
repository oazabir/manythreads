import { useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Touch gestures of a message row on a phone (P21-23, B10). A finger dragged to the right across a row opens its thread to reply; a finger held still
 * on a row opens the reaction picker. Both belong to touch only (a mouse or a pen never starts one), the list scrolls up and down as usual
 * (`touch-action: pan-y` on the row, channels.css), and every number is in this file so the unit test and the screen read the same thresholds.
 *
 * The decisions are plain functions of the finger's position (`startPress`, `movePress`, `releasePress`); the hook only feeds them pointer events
 * and keeps the one side effect (the row slides along with the finger).
 */

/** How far a finger must travel to the right before letting go counts as "reply". */
export const SWIPE_REPLY_PX = 64;
/** How long a finger held still opens the reaction picker. */
export const LONG_PRESS_MS = 500;
/** Moving the finger this far before the time is up is a scroll or a swipe, not a hold. */
export const HOLD_SLOP_PX = 8;
/** A drag counts as a sideways swipe once it has gone this far, and only while it is more sideways than up or down. */
export const SWIPE_START_PX = 12;
/** A swipe that wandered this far up or down by the time the finger is lifted is a scroll that happened to go right. */
export const SWIPE_MAX_DRIFT_PX = 40;
/** The row follows the finger up to here, then stops (a rubber band, not an unbounded drag). */
export const SWIPE_MAX_SHIFT_PX = 96;
/** Events the browser sends right after a finger is lifted (the click, a mouse press made from the tap) are ignored this long after a gesture fired. */
export const AFTER_GESTURE_MS = 700;

export type PressMode = 'idle' | 'swipe' | 'scroll' | 'long';
export type Press = { x: number; y: number; mode: PressMode };

export const startPress = (x: number, y: number): Press => ({ x, y, mode: 'idle' });

/** Whether the press has left the spot so far that a hold can no longer be one. */
export const leftTheSpot = (p: Press, x: number, y: number): boolean => Math.hypot(x - p.x, y - p.y) > HOLD_SLOP_PX;

/**
 * The press after the finger moved to (x, y), and how far the row should be shifted (0 outside a swipe). The mode is decided once, at the first
 * clear movement: more sideways than vertical and to the right is a swipe; anything else is a scroll the browser handles, and the row stays put.
 */
export function movePress(p: Press, x: number, y: number): { press: Press; shift: number } {
  if (p.mode === 'scroll' || p.mode === 'long') return { press: p, shift: 0 };
  const dx = x - p.x;
  const dy = y - p.y;
  let mode: PressMode = p.mode;
  if (mode === 'idle' && Math.hypot(dx, dy) >= SWIPE_START_PX) mode = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 ? 'swipe' : 'scroll';
  const press = mode === p.mode ? p : { ...p, mode };
  return { press, shift: mode === 'swipe' ? Math.max(0, Math.min(dx, SWIPE_MAX_SHIFT_PX)) : 0 };
}

/** What lifting the finger at (x, y) does. */
export function releasePress(p: Press, x: number, y: number): 'reply' | 'none' {
  if (p.mode !== 'swipe') return 'none';
  return x - p.x >= SWIPE_REPLY_PX && Math.abs(y - p.y) <= SWIPE_MAX_DRIFT_PX ? 'reply' : 'none';
}

/** What a press on this part of a row must leave alone: a link, a button, a picture, a text box: they have their own touch behaviour. */
export const GESTURE_IGNORES = 'a,button,textarea,input,select,summary,video,audio,iframe,[contenteditable],.acts,.edit-box,.poll,.vpop,.msg-imgs,.lp-card';

type Options = {
  /** False where the row has nothing to open (inside a thread, or a message nobody can reply to). */
  swipe: boolean;
  /** False while the row is being edited or is gone. */
  hold: boolean;
  onSwipeReply: () => void;
  onHold: () => void;
};

type Handlers = {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
};

/**
 * Handlers for a message row. `justFired()` is true for a moment after a swipe or a hold: the row's click handler and its menu's "press outside" check
 * use it to ignore the click and the mouse press the browser makes out of the same tap.
 */
export function useRowGestures(opts: Options): { handlers: Handlers; justFired: () => boolean } {
  const press = useRef<Press | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedAt = useRef(Number.NEGATIVE_INFINITY);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const clearTimer = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const settle = useCallback((el: HTMLElement | null): void => {
    if (!el) return;
    el.style.removeProperty('--swipe-x');
    delete el.dataset['swiping'];
    delete el.dataset['swipeReady'];
  }, []);

  const handlers = useMemo<Handlers>(
    () => ({
      onPointerDown(e) {
        const o = optsRef.current;
        if (e.pointerType !== 'touch' || !e.isPrimary || (!o.swipe && !o.hold)) return;
        if ((e.target as HTMLElement).closest(GESTURE_IGNORES)) return;
        const row = e.currentTarget;
        const p = startPress(e.clientX, e.clientY);
        press.current = p;
        clearTimer();
        if (o.hold) {
          timer.current = setTimeout(() => {
            timer.current = null;
            if (press.current !== p || p.mode !== 'idle') return;
            p.mode = 'long';
            firedAt.current = performance.now();
            settle(row);
            optsRef.current.onHold();
          }, LONG_PRESS_MS);
        }
      },
      onPointerMove(e) {
        const p = press.current;
        if (!p || e.pointerType !== 'touch') return;
        if (leftTheSpot(p, e.clientX, e.clientY)) clearTimer();
        if (!optsRef.current.swipe) return;
        const next = movePress(p, e.clientX, e.clientY);
        press.current = next.press;
        const el = e.currentTarget;
        if (next.press.mode === 'swipe') {
          el.dataset['swiping'] = '';
          el.style.setProperty('--swipe-x', `${next.shift}px`);
          if (next.shift >= SWIPE_REPLY_PX) el.dataset['swipeReady'] = '';
          else delete el.dataset['swipeReady'];
        }
      },
      onPointerUp(e) {
        const p = press.current;
        press.current = null;
        clearTimer();
        settle(e.currentTarget);
        if (!p) return;
        if (p.mode === 'long') {
          firedAt.current = performance.now();
          return;
        }
        if (optsRef.current.swipe && releasePress(p, e.clientX, e.clientY) === 'reply') {
          firedAt.current = performance.now();
          optsRef.current.onSwipeReply();
        } else if (p.mode === 'swipe') {
          // a swipe that did not go far enough: the click the browser makes of it must not toggle the row's bar
          firedAt.current = performance.now();
        }
      },
      onPointerCancel(e) {
        press.current = null;
        clearTimer();
        settle(e.currentTarget);
      },
      onContextMenu(e) {
        // a hold on a touch screen asks the browser for its own menu (copy, select) a moment after ours opens; one menu is enough
        if (performance.now() - firedAt.current < AFTER_GESTURE_MS || (press.current !== null && press.current.mode !== 'scroll')) {
          if (!(e.target as HTMLElement).closest(GESTURE_IGNORES)) e.preventDefault();
        }
      },
    }),
    [clearTimer, settle],
  );
  const justFired = useCallback((): boolean => performance.now() - firedAt.current < AFTER_GESTURE_MS, []);
  return { handlers, justFired };
}
