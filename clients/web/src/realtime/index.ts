import { useEffect, useSyncExternalStore } from 'react';
import { isMockMode } from '../api/setup';
import { channelStore } from '../channels/store';
import { linkPreviewStore } from '../linkpreview/store';
import { refreshDmsIfUsed } from '../dms/store';
import { notificationStore } from '../notifications/store';
import { noteActivity, refreshDirectories } from '../shell/channelFeed';
import { sidebarPrefsStore } from '../shell/sidebarPrefsStore';
import { RealtimeClient, browserDeps, type RealtimeStatus } from './socket';

/** The tab's one socket. Created on first use (it needs `window`), shared by everything that listens. */
let client: RealtimeClient | null = null;
export function realtimeClient(): RealtimeClient {
  client ??= new RealtimeClient(browserDeps());
  return client;
}

/**
 * Keep the socket open while the app shell is on screen: pushes feed the channel store, a reconnect refetches what was missed,
 * and a tab that comes back to the foreground does not wait for the backoff. Mock mode has no server, so no socket.
 */
export function useRealtime(): void {
  useEffect(() => {
    if (isMockMode()) return;
    const rt = realtimeClient();
    channelStore.attach(rt);
    notificationStore.attach(rt);
    linkPreviewStore.attach(rt);
    const offHook = channelStore.onResync(() => {
      refreshDirectories();
      refreshDmsIfUsed();
      sidebarPrefsStore.refreshAll(true);
    });
    const offActivity = channelStore.onActivity(noteActivity);
    const wake = (): void => {
      if (document.visibilityState === 'visible') rt.nudge();
    };
    // The person's sidebar view may have changed in another tab or on another device: ask again when this tab comes back (at most every 15 s).
    const back = (): void => {
      if (document.visibilityState === 'visible') sidebarPrefsStore.refreshAll();
    };
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    window.addEventListener('online', wake);
    rt.start();
    void channelStore.refreshSummary();
    void notificationStore.refreshSummary();
    return () => {
      document.removeEventListener('visibilitychange', wake);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
      window.removeEventListener('online', wake);
      offHook();
      offActivity();
      rt.stop();
    };
  }, []);
}

const noop = (): void => undefined;
const subscribeStatus = (listener: () => void): (() => void) => (isMockMode() ? noop : realtimeClient().onStatus(listener));
const statusNow = (): RealtimeStatus => (isMockMode() ? 'idle' : realtimeClient().status);

/** `open` when live pushes flow; anything else means the view may be stale until the socket is back. */
export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(subscribeStatus, statusNow);
}
