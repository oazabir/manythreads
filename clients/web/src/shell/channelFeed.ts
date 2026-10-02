import { useEffect, useState } from 'react';
import { isApiError } from '../api/client';
import { fetchNavChannels } from '../api/endpoints';
import type { NavChannelGroup } from '@manythreads/shared';

/*
 * Channel groups for the sidebar. The route belongs to the channels plugin, so the shell feature-detects it: a server
 * without it answers 404 and the slot stays empty. Once a server says 404 the answer is remembered for this page load.
 */
let supported: boolean | undefined;

export type ChannelFeed = { status: 'loading' | 'absent' | 'ok'; groups: NavChannelGroup[] };

export function useChannelFeed(teamSlug: string | null): ChannelFeed {
  const [loaded, setLoaded] = useState<{ slug: string; feed: ChannelFeed } | null>(null);
  useEffect(() => {
    if (!teamSlug || supported === false) return;
    let live = true;
    fetchNavChannels(teamSlug).then(
      (dir) => {
        supported = true;
        if (live) setLoaded({ slug: teamSlug, feed: { status: 'ok', groups: dir.groups } });
      },
      (e: unknown) => {
        if (isApiError(e) && e.status === 404 && supported === undefined) supported = false;
        if (live) setLoaded({ slug: teamSlug, feed: { status: 'absent', groups: [] } });
      },
    );
    return () => {
      live = false;
    };
  }, [teamSlug]);
  if (!teamSlug || supported === false) return { status: 'absent', groups: [] };
  return loaded?.slug === teamSlug ? loaded.feed : { status: 'loading', groups: [] };
}
