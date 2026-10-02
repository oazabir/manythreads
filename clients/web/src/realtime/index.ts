import { useEffect, useSyncExternalStore } from 'react';
import { isMockMode } from '../api/setup';
import { channelStore } from '../channels/store';
import { refreshDirectories } from '../shell/channelFeed';
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
    const offHook = channelStore.onResync(refreshDirectories);
    const wake = (): void => {
      if (document.visibilityState === 'visible') rt.nudge();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    rt.start();
    void channelStore.refreshSummary();
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      offHook();
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
