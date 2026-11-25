import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ActionItemView, Appointment, Approval, Notification, ThreadInboxItem } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { fetchThreadInbox } from '../../api/endpoints';
import { readRecent } from '../../app/recentPlaces';
import { readRecentThreads, type RecentThread } from '../../app/recentThreads';
import { useSession } from '../../app/session';
import { useQuery, type QueryState } from '../../app/useQuery';
import { useUnread } from '../../channels/hooks';
import { useDraftPlaces } from '../../channels/draftPlaces';
import { dmLabel, useDms } from '../../dms/store';
import { fetchAppointments } from '../../meetings/api';
import { liveRooms, useLive } from '../../meetings/store';
import { levelsStore } from '../../notifications/levelsStore';
import { levelOf } from '../../notifications/settingsModel';
import { notificationStore } from '../../notifications/store';
import { useNotifications } from '../../notifications/useNotifications';
import { useChannelFeed } from '../../shell/channelFeed';
import { useMeetingSpaces } from '../../meetings/spaces';
import { dmPath, meetingPath } from '../../shell/messageLink';
import { channelPath } from '../../shell/nav';
import { fetchActionItems } from '../files/actionItems/actionItemsApi';
import { fetchApprovals } from '../approvals/api';
import { useApprovalsChanged } from '../approvals/live';
import { addDays, startOfDay } from '../schedule/calendar';
import { channelPlaces, dmPlaces, type Place } from './summaries';

/*
 * What the Summaries page reads, one source at a time (P37-06): the person's action items, the requests waiting for them, the threads that wait on a reply, their
 * notifications, the next meetings and live calls, and the places they are in the middle of. Every source is read on its own, so one that fails empties only its own
 * card. The routes belong to plugins a server may not have: a 404 means "none here" and reads as an empty list. Nothing is new on the server; these are the reads the
 * Action items, Approvals, Threads, bell, Schedule and sidebar already make.
 */

export type Source<T> = QueryState<T> & { reload: () => void };

const NONE = (e: unknown): boolean => isApiError(e) && e.status === 404;
const orEmpty = <T>(empty: T) => (e: unknown): T => {
  if (NONE(e)) return empty;
  throw e;
};

/** The days the "Up next" card looks at: from the start of today for a week. */
export const UP_NEXT_DAYS = 7;

export interface SummariesData {
  actionItems: Source<{ items: readonly ActionItemView[] }>;
  approvals: Source<{ items: readonly Approval[] }>;
  threads: Source<{ items: readonly ThreadInboxItem[] }>;
  notifications: { status: 'loading' | 'ok' | 'error'; items: readonly Notification[]; reload: () => void };
  appointments: Source<{ appointments: readonly Appointment[] }>;
  live: ReturnType<typeof useLive>;
  keepGoing: { ready: boolean; places: readonly Place[]; recent: readonly string[]; quiet: (p: Place) => boolean; drafts: number; roomPath: (channelId: string) => string | null };
  /** The threads this person opened lately in this browser, newest first (read again on Refresh). */
  recentThreads: readonly RecentThread[];
  /** Reads everything again (the Refresh button). */
  reloadAll: () => void;
}

export function useSummaries(slug: string, now: Date): SummariesData {
  const session = useSession();
  const { threadsUnread, unread } = useUnread();
  const [tick, setTick] = useState(0);

  const actionItems = useQuery<{ items: readonly ActionItemView[] }>(`summaries:action-items:${tick}`, () => fetchActionItems().catch(orEmpty({ items: [] as ActionItemView[] })));
  const approvals = useQuery<{ items: readonly Approval[] }>(`summaries:approvals:${slug}:${tick}`, () => fetchApprovals(slug, 'pending').catch(orEmpty({ items: [] as Approval[] })));
  useApprovalsChanged(() => approvals.reload());
  // keyed on the unread count of threads too, so a reply that arrives while the page is open is read in
  const threads = useQuery<{ items: readonly ThreadInboxItem[] }>(`summaries:threads:${slug}:${threadsUnread}:${tick}`, () => fetchThreadInbox(slug, 'followed').catch(orEmpty({ items: [] as ThreadInboxItem[] })));
  const dayKey = startOfDay(now).toISOString();
  const appointments = useQuery<{ appointments: readonly Appointment[] }>(`summaries:appointments:${dayKey}:${tick}`, () =>
    fetchAppointments(dayKey, addDays(startOfDay(now), UP_NEXT_DAYS).toISOString()).catch(orEmpty({ appointments: [] as Appointment[] })),
  );

  // the bell's notifications: the store keeps them (and keeps them live); the page asks for the list once and again on Refresh
  const bell = useNotifications();
  useEffect(() => {
    void notificationStore.loadItems();
    void notificationStore.refreshSummary();
  }, []);
  const notifications = useMemo(
    () => ({
      status: bell.itemsStatus === 'ok' ? ('ok' as const) : bell.itemsStatus === 'error' ? ('error' as const) : ('loading' as const),
      items: bell.items,
      reload: () => void notificationStore.loadItems(),
    }),
    [bell.itemsStatus, bell.items],
  );

  const live = useLive();

  // the places: the sidebar's channel list and direct messages, with the unread counts the sidebar shows, and the ones opened lately
  const feed = useChannelFeed(slug);
  const dms = useDms();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  useEffect(() => {
    void levelsStore.load();
  }, []);
  const drafts = useDraftPlaces().length;
  const spaces = useMeetingSpaces();
  const selfId = session.person.id;
  const keepGoingData = useMemo(() => {
    const groups = feed.status === 'ok' ? feed.groups : [];
    const dmItems = dms.status === 'ok' ? dms.items : [];
    const places = [...channelPlaces(groups, slug, unread), ...dmPlaces(dmItems, slug, unread, (d) => dmLabel(d, selfId))];
    const where = new Map<string, string>([
      ...groups.flatMap((g) => g.channels.map((c): [string, string] => [c.id, channelPath(slug, c.name)])),
      ...dmItems.map((d): [string, string] => [d.channel.id, dmPath(slug, d.channel.id)]),
      ...(spaces.status === 'ok' ? spaces.data.spaces.map((s): [string, string] => [s.channelId, meetingPath(slug, s.channelId)]) : []),
    ]);
    return {
      ready: feed.status !== 'loading' && dms.status !== 'loading',
      places,
      recent: readRecent(selfId, slug),
      quiet: (p: Place): boolean => levelOf(levels, p.key.slice(p.key.indexOf(':') + 1), p.kind).effective === 'nothing',
      drafts,
      roomPath: (channelId: string): string | null => where.get(channelId) ?? null,
    };
  }, [feed, dms, slug, unread, selfId, levels, drafts, spaces]);

  // kept in this browser, so it is read again on Refresh (`tick`)
  const recentThreads = useMemo(() => (tick >= 0 ? readRecentThreads(selfId, slug) : []), [selfId, slug, tick]);

  const reloadAll = useCallback(() => {
    setTick((t) => t + 1);
    void notificationStore.loadItems();
    void liveRooms().refresh();
  }, []);

  return { actionItems, approvals, threads, notifications, appointments, live, keepGoing: keepGoingData, recentThreads, reloadAll } as SummariesData;
}
