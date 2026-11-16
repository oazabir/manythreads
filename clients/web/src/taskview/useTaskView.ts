import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isMockMode } from '../api/setup';
import { EMPTY_TASK_VIEW, type TaskViewState } from './channelTasks';
import { channelTasksStore } from './store';

/** The page shows this channel's task views: one lease and three reads for all its rows, until the page leaves. Mock mode has no server. */
export function useTrackChannelTasks(channelId: string | null): void {
  useEffect(() => {
    if (channelId === null || isMockMode()) return;
    return channelTasksStore.track(channelId);
  }, [channelId]);
}

/** What one root shows under it in the channel: the shared empty object while it has nothing, so a row with nothing never re-renders for the others. */
export function useTaskView(rootId: string): TaskViewState {
  const subscribe = useCallback((onChange: () => void) => channelTasksStore.subscribe(rootId, onChange), [rootId]);
  return useSyncExternalStore(subscribe, () => channelTasksStore.stateOf(rootId), () => EMPTY_TASK_VIEW);
}
