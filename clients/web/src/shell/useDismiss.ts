import { useEffect, useRef, type RefObject } from 'react';

/** The popovers and drawers that are open now, oldest first: Esc closes only the newest, so a menu inside a drawer goes before the drawer. */
const openStack: symbol[] = [];

/**
 * Close a popover or drawer on a press outside it or on Esc. Esc is taken first (capture phase) and marked handled, so
 * the right panel behind it stays open until the next press. When several are open (a menu in the phone's drawer), Esc closes
 * the one opened last and stops there; the next Esc closes the one under it.
 */
export function useDismiss(open: boolean, onClose: () => void, inside: RefObject<HTMLElement | null>): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const me = Symbol('dismiss');
    openStack.push(me);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (openStack[openStack.length - 1] !== me) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    const onPress = (e: MouseEvent): void => {
      if (inside.current && !inside.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPress);
    return () => {
      const at = openStack.indexOf(me);
      if (at >= 0) openStack.splice(at, 1);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPress);
    };
  }, [open, inside]);
}
