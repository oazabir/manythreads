import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isMockMode } from '../api/setup';
import { threadTodoStore } from './store';
import type { ThreadTodoState } from './threadTodo';

const NO_STATE: ThreadTodoState = { loaded: false, todo: null };

/** The to-do list of the thread a panel shows, live. `null` (no thread) and mock mode (no server) read nothing and answer no list. */
export function useThreadTodo(rootId: string | null): ThreadTodoState {
  useEffect(() => {
    if (rootId === null || isMockMode()) return;
    return threadTodoStore.open(rootId);
  }, [rootId]);
  const subscribe = useCallback((onChange: () => void) => (rootId === null ? () => undefined : threadTodoStore.subscribe(rootId, onChange)), [rootId]);
  return useSyncExternalStore(subscribe, () => (rootId === null ? NO_STATE : threadTodoStore.stateOf(rootId)));
}
