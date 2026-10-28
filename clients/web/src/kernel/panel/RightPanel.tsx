import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import './builtins';
import { BackIcon, CloseIcon, ExpandIcon, RestoreIcon } from '../../shell/icons';
import { useNarrow } from '../../shell/useNarrow';
import { PANEL_MIN, PANEL_STEP, clampPanelWidth, maxPanelWidth, usePanelWidth, widthFromPointer } from './panelSize';
import { panelRegistry } from './registry';
import { PanelSubContext, PanelTitleContext } from './sub';
import { useEscapeToClose, usePanel } from './usePanel';

/** The right-hand panel (landmark `right-panel`): hidden until an entry is open; the top entry is rendered, Back walks down. */
export function RightPanel() {
  const panel = usePanel();
  const [sub, setSub] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const narrow = useNarrow();
  const size = usePanelWidth();
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const top = panel.entries.at(-1);
  const def = top ? panelRegistry.get(top.type) : undefined;
  const isThread = top?.type === 'thread';
  // a narrower window clamps the kept width again; the panel closing, or showing something that is not a thread, ends the expanded view
  useEffect(() => {
    const on = (): void => setViewport(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useEffect(() => {
    if (!top || !isThread) setExpanded(false);
  }, [top, isThread]);
  // Esc first brings an expanded thread back to its width; only then does it close the panel
  useEscapeToClose(panel.open, expanded ? () => setExpanded(false) : panel.close);

  const shown = clampPanelWidth(size.width, viewport);
  const resizable = !narrow;
  const fill = expanded && resizable && isThread;
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection starts under the drag
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragging) size.set(widthFromPointer(e.clientX, window.innerWidth));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    size.keep(widthFromPointer(e.clientX, window.innerWidth));
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // the bar is on the panel's left edge: left makes the panel wider, right narrower
    const by = e.key === 'ArrowLeft' ? PANEL_STEP : e.key === 'ArrowRight' ? -PANEL_STEP : 0;
    if (by === 0) return;
    e.preventDefault();
    size.keep(clampPanelWidth(shown + by, window.innerWidth));
  };

  return (
    <aside
      className="region right-panel"
      data-landmark="right-panel"
      data-expanded={fill ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      aria-label="Panel"
      hidden={!top}
      style={top && resizable && !fill ? { width: shown } : undefined}
    >
      {top ? (
        <>
          {resizable && !fill ? (
            <div
              className="panel-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panel"
              aria-valuemin={PANEL_MIN}
              aria-valuemax={maxPanelWidth(viewport)}
              aria-valuenow={shown}
              tabIndex={0}
              data-testid="panel-resizer"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={onKey}
              onDoubleClick={size.restoreDefault}
            />
          ) : null}
          <header className="panel-head" data-landmark="panel-header">
            {panel.hasBack ? (
              <button type="button" className="icon-btn" aria-label="Back" onClick={panel.back}><BackIcon /></button>
            ) : null}
            <div className="panel-titles">
              <h2 className="panel-title" data-testid="panel-title">{title ?? def?.label ?? 'Panel'}</h2>
              {sub ? <p className="panel-sub" data-testid="thread-channel">{sub}</p> : null}
            </div>
            {resizable && isThread ? (
              <button type="button" className="icon-btn panel-expand" aria-label={expanded ? 'Restore' : 'Expand thread'} aria-pressed={expanded} title={expanded ? 'Restore' : 'Expand thread'} data-testid="panel-expand" onClick={() => setExpanded((v) => !v)}>
                {expanded ? <RestoreIcon /> : <ExpandIcon />}
              </button>
            ) : null}
            <button type="button" className="icon-btn panel-close" aria-label="Close panel" onClick={panel.close}><CloseIcon /></button>
          </header>
          <div className="panel-body" data-landmark="panel-body" data-panel-entry={`${top.type}:${top.id}`}>
            {def ? (
              <PanelSubContext.Provider value={setSub}>
                <PanelTitleContext.Provider value={setTitle}>
                  <def.Component entry={top} />
                </PanelTitleContext.Provider>
              </PanelSubContext.Provider>
            ) : (
              <div className="panel-empty">
                <p className="panel-empty-title">Not available</p>
                <p className="panel-empty-body">This item cannot be shown here.</p>
              </div>
            )}
          </div>
        </>
      ) : null}
    </aside>
  );
}
