import { useState } from 'react';
import './builtins';
import { BackIcon, CloseIcon } from '../../shell/icons';
import { panelRegistry } from './registry';
import { PanelSubContext, PanelTitleContext } from './sub';
import { useEscapeToClose, usePanel } from './usePanel';

/** The right-hand panel (landmark `right-panel`): hidden until an entry is open; the top entry is rendered, Back walks down. */
export function RightPanel() {
  const panel = usePanel();
  const [sub, setSub] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  useEscapeToClose(panel.open, panel.close);
  const top = panel.entries.at(-1);
  const def = top ? panelRegistry.get(top.type) : undefined;
  return (
    <aside className="region right-panel" data-landmark="right-panel" aria-label="Panel" hidden={!top}>
      {top ? (
        <>
          <header className="panel-head" data-landmark="panel-header">
            {panel.hasBack ? (
              <button type="button" className="icon-btn" aria-label="Back" onClick={panel.back}><BackIcon /></button>
            ) : null}
            <div className="panel-titles">
              <h2 className="panel-title" data-testid="panel-title">{title ?? def?.label ?? 'Panel'}</h2>
              {sub ? <p className="panel-sub" data-testid="thread-channel">{sub}</p> : null}
            </div>
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
