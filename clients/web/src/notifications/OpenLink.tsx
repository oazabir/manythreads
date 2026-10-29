import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { fetchChannel } from '../api/endpoints';
import { useOpenMessage } from '../shell/messageLink';
import { registerWorker } from './push';
import { safeOpenPath } from './settingsModel';

/**
 * Where a push notification leads (PLAN P14-09): `/open?channel=<id>&message=<id>[&root=<id>]`. The link carries only ids, so the page looks the
 * channel up (which also checks the person may still read it) and then opens the message the way the inbox does.
 */
export function useOpenFromParams(): (params: URLSearchParams) => Promise<void> {
  const openMessage = useOpenMessage();
  const navigate = useNavigate();
  return async (params) => {
    const channelId = params.get('channel');
    const messageId = params.get('message');
    if (!channelId || !messageId) {
      navigate('/', { replace: true });
      return;
    }
    try {
      const { channel } = await fetchChannel(channelId);
      await openMessage({ channelId, channelKind: channel.kind, channelName: channel.kind === 'channel' ? channel.name : null, teamId: channel.teamId ?? null, messageId, threadRootId: params.get('root') });
    } catch {
      navigate('/', { replace: true });
    }
  };
}

/** The `/open` page: nothing to see, it sends the person on to the message. */
export function OpenRoute() {
  const [params] = useSearchParams();
  const open = useOpenFromParams();
  const key = params.toString();
  useEffect(() => {
    void open(new URLSearchParams(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per link
  }, [key]);
  return <div className="view-empty" role="status" aria-busy="true"><p className="view-empty-body">Opening the message…</p></div>;
}

/** Registers the service worker once the person is in the app, and follows a click on a push notification while a tab is already open. */
export function PushBridge() {
  const open = useOpenFromParams();
  useEffect(() => {
    void registerWorker();
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (!data || data.type !== 'manythreads.open' || typeof data.url !== 'string') return;
      const path = safeOpenPath(data.url, window.location.origin);
      void open(new URL(path, window.location.origin).searchParams);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` is rebuilt every render and only reads current hooks
  }, []);
  return null;
}
