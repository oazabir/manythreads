import { useLayoutEffect, useState, type RefObject } from 'react';

const GAP = 4;

/**
 * Which side of its anchor an absolutely placed popover opens on: `true` = above. It opens below by default; when it does not fit between its
 * anchor and the bottom edge of the scroll area it sits in (the message list ends at the composer, and a menu that reaches over that edge is cut
 * off or lies under the composer) and there is more room above, it opens upward. The anchor is the popover's offset parent; the room is measured
 * from geometry, not from where the popover is now, so a flip does not make it flip back, and again when the popover's own size changes.
 */
export function usePopoverAbove(ref: RefObject<HTMLElement | null>): boolean {
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const anchor = el.offsetParent;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const area = el.closest('.vlist, [role="log"]')?.getBoundingClientRect();
      const top = area?.top ?? 0;
      const bottom = area?.bottom ?? window.innerHeight;
      const need = el.offsetHeight + GAP;
      const below = bottom - a.bottom;
      const over = a.top - top;
      setAbove(need > below && over > below);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return above;
}
