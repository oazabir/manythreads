import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { createPanelController, type PanelController } from './controller';
import type { PanelEntry, PanelHistory, PanelLocation } from './stack';

export type PanelApi = PanelController & { entries: PanelEntry[]; open: boolean; hasBack: boolean };

/** `panel.push / back / close` bound to the router, plus what to render: the stack and whether anything is open. */
export function usePanel(): PanelApi {
  const loc = useLocation();
  const navigate = useNavigate();
  // The latest location, also between a call and the re-render it causes (two pushes in one event).
  const latest = useRef({ pathname: loc.pathname, search: loc.search, state: loc.state as unknown });
  latest.current = { pathname: loc.pathname, search: loc.search, state: loc.state as unknown };

  const controller = useMemo(() => {
    const write = (next: PanelLocation, replace: boolean): void => {
      latest.current = { ...latest.current, ...next };
      navigate({ pathname: latest.current.pathname, search: next.search }, { state: next.state, replace });
    };
    const history: PanelHistory = {
      read: () => ({ search: latest.current.search, state: latest.current.state }),
      push: (next) => write(next, false),
      replace: (next) => write(next, true),
      back: () => void navigate(-1),
    };
    return createPanelController(history);
  }, [navigate]);

  const entries = controller.stack();
  return { ...controller, entries, open: entries.length > 0, hasBack: entries.length > 1 };
}

/** Esc closes the panel unless something nearer (a menu, a dialog) already used the key. */
export function useEscapeToClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
}
