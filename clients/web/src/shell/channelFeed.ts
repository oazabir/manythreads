import { useEffect, useSyncExternalStore } from 'react';
import { isApiError } from '../api/client';
import { fetchNavChannels } from '../api/endpoints';
import type { NavChannel, NavChannelGroup } from '@manythreads/shared';
import { channelStore } from '../channels/store';
import { onPersonChange } from '../app/caches';

/*
 * Channel groups for the sidebar and the channel view (one copy, shared). The route belongs to the channels plugin, so the shell
 * feature-detects it: a server without it answers 404 and the slot stays empty. Once a server says 404 the answer is remembered
 * for this page load. A channel created elsewhere or a reconnected socket refreshes every directory that is held.
 */
let supported: boolean | undefined;

export type ChannelFeed = { status: 'loading' | 'absent' | 'ok'; groups: NavChannelGroup[] };

const LOADING: ChannelFeed = { status: 'loading', groups: [] };
const ABSENT: ChannelFeed = { status: 'absent', groups: [] };
const feeds = new Map<string, ChannelFeed>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export async function refreshDirectory(slug: string): Promise<void> {
  if (supported === false || inflight.has(slug)) return;
  inflight.add(slug);
  try {
    const dir = await fetchNavChannels(slug);
    supported = true;
    feeds.set(slug, { status: 'ok', groups: dir.groups });
    channelStore.seedUnread(dir.groups.flatMap((g) => g.channels));
  } catch (e) {
    if (isApiError(e) && e.status === 404 && supported === undefined) supported = false;
    if (!feeds.has(slug)) feeds.set(slug, ABSENT);
  } finally {
    inflight.delete(slug);
    emit();
  }
}

/** Refetch every directory held (a channel was created, the socket reconnected). */
export function refreshDirectories(): void {
  for (const slug of feeds.keys()) void refreshDirectory(slug);
}

onPersonChange(() => {
  feeds.clear();
  emit();
});

export function useChannelFeed(teamSlug: string | null): ChannelFeed {
  const feed = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (teamSlug ? feeds.get(teamSlug) : undefined),
  );
  // The first load for a team (a no-op when one is held or under way); the subscription above delivers the result.
  useEffect(() => {
    if (teamSlug && !feeds.has(teamSlug)) void refreshDirectory(teamSlug);
  }, [teamSlug]);
  if (!teamSlug || supported === false) return ABSENT;
  return feed ?? LOADING;
}

/** The channel of a team by the name in the URL (`dev` or `#dev`, any case), if the directory lists it. */
export function findChannel(groups: readonly NavChannelGroup[], name: string): NavChannel | undefined {
  const want = name.replace(/^#/, '').toLowerCase();
  for (const g of groups) for (const c of g.channels) if (c.name.replace(/^#/, '').toLowerCase() === want) return c;
  return undefined;
}
