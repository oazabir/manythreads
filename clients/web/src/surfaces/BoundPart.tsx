import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SURFACE_REGISTRY, type SurfaceBind, type SurfaceDataResponse } from '@manythreads/shared';
import { createBoundController, type BoundFailure, type BoundState } from './bound';

/*
 * A part whose values come from a read tool (PLAN P9-06). The page lends the one way to read (`SurfaceDataContext.read`): it asks the server for the part by its
 * name and the screen's version, and the server runs the tool AS THE PERSON LOOKING. This component never sees a tool name or an argument; it only gets values
 * back, and those are checked once more here against the part's own schema before they are drawn. The values are plain data drawn as text, like the ones the bot wrote.
 * While the data is on its way, or when there is none, or when it cannot be read, the part is replaced by one plain sentence; if a later refresh fails the last
 * good values stay on the screen with a note.
 */

/** What a screen's page lends to the bound parts in it. Without `read` (a preview, a draft) the parts are drawn as written, with a note. */
export interface SurfaceData {
  /** Reads the bound data of one part (by its name) for the version of the screen being shown. Throws an `ApiError` when refused. */
  read: ((nodeId: string) => Promise<SurfaceDataResponse>) | null;
  /** The version of the screen: every new version reads all bound parts again (the binding itself may have changed). */
  version: number;
  /** Goes up by one each time the person's answer on this screen went through (for a binding with `refreshOn: ["answered"]`). */
  answered: number;
  /** How a refused read is explained; the page knows its own error type. */
  explain: (e: unknown) => BoundFailure;
}

const NO_DATA: SurfaceData = { read: null, version: 0, answered: 0, explain: () => ({ message: 'Could not load this data.', code: 'unavailable' }) };
export const SurfaceDataContext = createContext<SurfaceData>(NO_DATA);

export const BOUND_TEXT = {
  loading: 'Loading data…',
  empty: 'Nothing to show yet.',
  noReader: 'Live data is not shown in this view.',
  stale: 'Could not refresh. Showing the last data we have.',
  misfit: 'The data does not fit this part.',
} as const;

/** The values to draw for a state, or the sentence to show instead. Pure, so it can be tested without a page. */
export function boundDisplay(
  state: BoundState,
  written: Record<string, unknown>,
  parse: (merged: Record<string, unknown>) => { success: boolean },
): { props: Record<string, unknown> | null; note: string | null; tone: 'info' | 'error' } {
  const fit = (values: Record<string, unknown>): Record<string, unknown> | null => {
    const merged = { ...written, ...values };
    return parse(merged).success ? merged : null;
  };
  switch (state.kind) {
    case 'loading':
      return { props: null, note: BOUND_TEXT.loading, tone: 'info' };
    case 'empty':
      return { props: null, note: BOUND_TEXT.empty, tone: 'info' };
    case 'ok': {
      const merged = fit(state.props);
      return merged ? { props: merged, note: null, tone: 'info' } : { props: null, note: BOUND_TEXT.misfit, tone: 'error' };
    }
    case 'error': {
      const merged = state.last ? fit(state.last) : null;
      return merged ? { props: merged, note: `${BOUND_TEXT.stale}`, tone: 'error' } : { props: null, note: state.message, tone: 'error' };
    }
  }
}

function useBoundState(nodeId: string, bind: SurfaceBind, data: SurfaceData): BoundState {
  const [state, setState] = useState<BoundState>({ kind: 'loading' });
  const controller = useRef<ReturnType<typeof createBoundController> | null>(null);
  const read = data.read;
  const bindKey = JSON.stringify(bind);
  const explain = useRef(data.explain);
  explain.current = data.explain;

  // One controller for as long as the part, its binding and the screen's version stay the same; a new version starts over and reads at once.
  useEffect(() => {
    if (read === null) return undefined;
    setState((prev) => (prev.kind === 'ok' ? prev : { kind: 'loading' }));
    const c = createBoundController(bind.refreshSeconds, {
      read: () => read(nodeId),
      fail: (e) => explain.current(e),
      visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onState: setState,
    });
    controller.current = c;
    const onVisible = (): void => c.visibilityChanged();
    document.addEventListener('visibilitychange', onVisible);
    c.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      c.stop();
      controller.current = null;
    };
    // `bindKey` stands for `bind`: the object is new on each render of the tree, its content is what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, nodeId, bindKey, data.version]);

  const answeredSeen = useRef(data.answered);
  useEffect(() => {
    if (data.answered === answeredSeen.current) return;
    answeredSeen.current = data.answered;
    if (bind.refreshOn?.includes('answered')) controller.current?.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.answered, bindKey]);

  return state;
}

export function BoundPart({
  draw,
  name,
  nodeId,
  props,
  bind,
}: {
  /** Draws the part with the values given (the page's own view of it). */
  draw: (props: Record<string, unknown>) => ReactNode;
  name: string;
  nodeId: string;
  props: Record<string, unknown>;
  bind: SurfaceBind;
}): ReactNode {
  const data = useContext(SurfaceDataContext);
  const state = useBoundState(nodeId, bind, data);
  const def = SURFACE_REGISTRY.get(name);
  const shown = useMemo(
    () => boundDisplay(state, props, (merged) => (def ? def.props.safeParse(merged) : { success: false })),
    [state, props, def],
  );
  if (data.read === null) {
    return (
      <div className="sf-bound" data-testid="surface-bound" data-state="static">
        {draw(props)}
        <div className="sf-bound-note">{BOUND_TEXT.noReader}</div>
      </div>
    );
  }
  return (
    <div className="sf-bound" data-testid="surface-bound" data-state={state.kind} aria-busy={state.kind === 'loading' ? true : undefined}>
      {shown.props ? draw(shown.props) : null}
      {shown.note ? (
        <div className={`sf-bound-note${shown.tone === 'error' ? ' sf-bound-error' : ''}`} role={shown.tone === 'error' ? 'status' : undefined}>
          {shown.note}
        </div>
      ) : null}
    </div>
  );
}
