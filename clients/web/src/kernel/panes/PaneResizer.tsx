import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { clampPane, PANE_STEP, usePaneWidth, widthForPointer, type PaneSpec } from './paneWidth';

/**
 * The bar on a pane's edge that changes its width (the right panel has its own, kernel/panel/RightPanel.tsx, which looks the same and is dragged
 * and moved by the arrow keys the same way):
 * drag it, or focus it and press the arrow keys; Home gives the pane's least width and End its most. Escape cancels a drag and a double click restores the default. It sits inside the pane (which is `position: relative`), on its
 * `end` edge (a pane on the left) or its `start` edge (a pane on the right). The width it sets reaches the stylesheet as `--pane-<id>` on the page's root
 * (paneWidth.ts). Not drawn at phone width (styles/panes.css).
 */
export function PaneResizer({ spec, edge }: { spec: PaneSpec; edge: 'start' | 'end' }) {
  const size = usePaneWidth(spec);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; cleanup: () => void } | null>(null);
  useEffect(() => () => drag.current?.cleanup(), []);
  const measure = (bar: HTMLElement, clientX: number): number | null => {
    const pane = bar.parentElement;
    if (!pane) return null;
    const room = pane.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return widthForPointer(spec, edge, clientX, pane.getBoundingClientRect(), room);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); // no text selection starts under the drag
    const bar = e.currentTarget;
    const { pointerId } = e;
    const startingWidth = size.width;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      setDragging(false);
      size.set(startingWidth);
    };
    const cleanup = (): void => {
      drag.current = null;
      window.removeEventListener('keydown', onEscape, true);
      if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
    };

    bar.setPointerCapture(pointerId);
    drag.current = { pointerId, cleanup };
    // Pointer-down keeps focus where it was, so listen outside the separator.
    window.addEventListener('keydown', onEscape, true);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== e.pointerId) return;
    const w = measure(e.currentTarget, e.clientX);
    if (w !== null) size.set(w);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    active.cleanup();
    setDragging(false);
    const w = measure(e.currentTarget, e.clientX);
    if (w !== null) size.keep(w);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Home and End go to the pane's own least and most width, whichever edge the bar is on
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      size.keep(e.key === 'Home' ? spec.min : spec.max);
      return;
    }
    // the arrow points where the bar moves: on a pane's end edge right is wider, on its start edge left is wider
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const shown = e.currentTarget.parentElement?.getBoundingClientRect().width || size.width;
    size.keep(clampPane(spec, shown + (edge === 'end' ? dir : -dir) * PANE_STEP));
  };
  return (
    <div
      className="pane-resizer"
      data-edge={edge}
      data-dragging={dragging ? 'true' : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={spec.label}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={size.width}
      tabIndex={0}
      data-testid={`pane-resizer-${spec.id}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
      onDoubleClick={size.restoreDefault}
    />
  );
}
