import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close a popover or drawer on a press outside it or on Esc. Esc is taken first (capture phase) and marked handled, so
 * the right panel behind it stays open until the next press.
 */
export function useDismiss(open: boolean, onClose: () => void, inside: RefObject<HTMLElement | null>): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    const onPress = (e: MouseEvent): void => {
      if (inside.current && !inside.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPress);
    };
  }, [open, inside]);
}
