import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { fetchSession } from '../api/endpoints';
import { onSessionExpired } from '../api/client';
import type { AuthenticatedSession } from '@manythreads/shared';
import { FullPageMessage } from '../components/states';
import { dropPersonData } from './caches';
import { signInUrl } from './paths';

export type SessionState =
  | { status: 'loading' }
  /** `signedOut`: the person chose to leave, so sign-in does not need a return path. */
  | { status: 'anonymous'; signedOut?: boolean }
  | { status: 'ready'; session: AuthenticatedSession }
  | { status: 'error'; message: string };

type SessionContextValue = {
  state: SessionState;
  /** Set after sign-in or bootstrap (an AuthenticatedSession), or null after sign-out. */
  setSession: (s: AuthenticatedSession | null) => void;
  refresh: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fetchSession().then(
      (s) => live && setState(s.authenticated ? { status: 'ready', session: s } : { status: 'anonymous' }),
      (e: unknown) => live && setState({ status: 'error', message: e instanceof Error ? e.message : 'Could not reach the server.' }),
    );
    return () => {
      live = false;
    };
  }, [tick]);

  // Whatever was loaded for one person is not shown to the next one in this tab.
  const who = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (state.status === 'loading' || state.status === 'error') return;
    const id = state.status === 'ready' ? state.session.person.id : null;
    if (who.current !== undefined && who.current !== id) dropPersonData();
    who.current = id;
  }, [state]);

  // A 401 anywhere means the session expired: RequireSession then redirects to /sign-in?return=<path>.
  useEffect(() => onSessionExpired(() => setState({ status: 'anonymous' })), []);

  const setSession = useCallback((s: AuthenticatedSession | null) => setState(s ? { status: 'ready', session: s } : { status: 'anonymous', signedOut: true }), []);
  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    setTick((t) => t + 1);
  }, []);
  const value = useMemo(() => ({ state, setSession, refresh }), [state, setSession, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionState(): SessionContextValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSessionState outside SessionProvider');
  return v;
}

/** The signed-in session. Only call below <RequireSession>. */
export function useSession(): AuthenticatedSession {
  const { state } = useSessionState();
  if (state.status !== 'ready') throw new Error('useSession without a ready session');
  return state.session;
}

export const isAdmin = (s: AuthenticatedSession): boolean => s.role === 'owner' || s.role === 'admin';

/** Layout route: children render only with a session, otherwise go to sign-in keeping the path (criterion 4). */
export function RequireSession() {
  const { state, refresh } = useSessionState();
  const loc = useLocation();
  if (state.status === 'loading') return <FullPageMessage title="Loading" busy />;
  if (state.status === 'anonymous') return <Navigate to={state.signedOut ? '/sign-in' : signInUrl(loc.pathname + loc.search)} replace />;
  if (state.status === 'error') {
    return (
      <FullPageMessage title="Cannot reach manythreads" tone="alert" detail={state.message}>
        <button type="button" className="btn primary" onClick={refresh}>Try again</button>
      </FullPageMessage>
    );
  }
  return <Outlet />;
}
