import { useSyncExternalStore } from 'react';
import { notificationStore } from './store';

/** The bell's data (count, list, settings) as the store holds it right now; re-renders when it changes. */
export function useNotifications() {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
}
