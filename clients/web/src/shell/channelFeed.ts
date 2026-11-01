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
/** Directories asked for again while a fetch was under way: that fetch may have started before the change, so one more runs when it ends. */
const again = new Set<string>();
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export async function refreshDirectory(slug: string): Promise<void> {
  if (supported === false) return;
  if (inflight.has(slug)) {
    again.add(slug);
    return;
  }
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
    if (again.delete(slug)) void refreshDirectory(slug);
  }
}

/** Refetch every directory held (a channel was created, the socket reconnected). */
export function refreshDirectories(): void {
  for (const slug of feeds.keys()) void refreshDirectory(slug);
}

/**
 * A message arrived in a channel: remember it as the channel's newest activity in every directory held, so a sidebar sorted by recent activity
 * moves the channel up without another fetch. Never moves a time backwards.
 */
export function noteActivity(channelId: string, at: string): void {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return;
  let changed = false;
  for (const [slug, feed] of feeds) {
    if (feed.status !== 'ok') continue;
    let touched = false;
    const groups = feed.groups.map((g) => {
      if (!g.channels.some((c) => c.id === channelId && !(c.lastActivityAt && Date.parse(c.lastActivityAt) >= t))) return g;
      touched = true;
      return { ...g, channels: g.channels.map((c) => (c.id === channelId ? { ...c, lastActivityAt: at } : c)) };
    });
    if (touched) {
      feeds.set(slug, { status: 'ok', groups });
      changed = true;
    }
  }
  if (changed) emit();
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
