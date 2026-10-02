import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, type ApiError } from '../api/client';

export type QueryState<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: ApiError | Error };

/** Load data for a screen. `key` identifies the request: a new key reloads. */
export function useQuery<T>(key: string, load: () => Promise<T>): QueryState<T> & { reload: () => void } {
  const [state, setState] = useState<QueryState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let live = true;
    setState((s) => (s.status === 'ok' ? s : { status: 'loading' }));
    loadRef.current().then(
      (data) => live && setState({ status: 'ok', data }),
      (error: unknown) => live && setState({ status: 'error', error: isApiError(error) ? error : error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      live = false;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload } as QueryState<T> & { reload: () => void };
}
