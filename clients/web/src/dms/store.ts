import { useEffect, useSyncExternalStore } from 'react';
import { REMINDERS_DM_KEY_PREFIX, type DirectMessageSummary } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchDms, openDm } from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import { channelStore } from '../channels/store';

/*
 * The person's direct messages for the sidebar and the DM screen (docs/plugins/direct-messages.md). One list for the page: the route
 * belongs to the direct-messages plugin, so a 404 means "no DMs here" and the section shows its empty state. A conversation made
 * by someone else arrives as a `channel.created` push, which refreshes the list (see realtime/index.ts).
 */
export type DmFeed = { status: 'loading' | 'absent' | 'ok' | 'error'; items: readonly DirectMessageSummary[] };

const LOADING: DmFeed = { status: 'loading', items: [] };
let feed: DmFeed = LOADING;
let started = false;
let inflight = false;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export async function refreshDms(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const page = await fetchDms();
    feed = { status: 'ok', items: page.items };
    channelStore.seedUnread(page.items.map((d) => ({ id: d.channel.id, unread: d.unreadCount })));
  } catch (e) {
    feed = feed.status === 'ok' ? feed : { status: isApiError(e) && (e.status === 404 || e.status === 403) ? 'absent' : 'error', items: [] };
  } finally {
    inflight = false;
    emit();
  }
}

/** After a reconnect or a `channel.created` push: refetch the list, if anything has asked for it yet. */
export function refreshDmsIfUsed(): void {
  if (started) void refreshDms();
}

onPersonChange(() => {
  feed = LOADING;
  started = false;
  emit();
});

/** Opens (or finds) the conversation with these people and makes sure it is in the list; returns its channel id. */
export async function openConversation(personIds: readonly string[]): Promise<DirectMessageSummary> {
  const { dm } = await openDm(personIds);
  if (!feed.items.some((d) => d.channel.id === dm.channel.id)) {
    feed = { status: 'ok', items: [dm, ...feed.items] };
    emit();
  }
  return dm;
}

export function useDms(enabled = true): DmFeed {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => feed,
  );
  useEffect(() => {
    if (enabled && !started) {
      started = true;
      void refreshDms();
    }
  }, [enabled]);
  return value;
}

/** Names of the other people in a conversation (the sidebar row); a conversation with only yourself is "Notes to self". */
export function dmLabel(dm: DirectMessageSummary, selfPersonId: string): string {
  // the person's own Reminders conversation (docs/plugins/reminders.md): the reminders plugin posts into it as "Reminders"
  if (dm.channel.dmKey?.startsWith(REMINDERS_DM_KEY_PREFIX)) return 'Reminders';
  const others = dm.participants.filter((p) => p.personId !== selfPersonId).map((p) => p.displayName);
  return others.length > 0 ? others.join(', ') : 'Notes to self';
}

/** The header of a conversation: everyone in it, as the wireframe shows ("Nadia, Rafi"). */
export const dmParticipants = (dm: DirectMessageSummary): string => dm.participants.map((p) => p.displayName).join(', ');

/** What a conversation's header names: one other person (their dot, status and time are drawn), a group, or the person alone. */
export type DmHeaderTitle = { kind: 'person'; personId: string; name: string } | { kind: 'group'; name: string } | { kind: 'plain'; name: string };

/** The header title of a conversation: the other person for a one-to-one, the others' names (not the reader's own) for a group, plain text for Reminders and Notes to self. */
export function dmHeaderTitle(dm: DirectMessageSummary, selfPersonId: string): DmHeaderTitle {
  const name = dmLabel(dm, selfPersonId);
  if (dm.channel.dmKey?.startsWith(REMINDERS_DM_KEY_PREFIX)) return { kind: 'plain', name };
  const others = dm.participants.filter((p) => p.personId !== selfPersonId);
  if (others.length === 0) return { kind: 'plain', name };
  return others.length === 1 ? { kind: 'person', personId: others[0]!.personId, name } : { kind: 'group', name };
}
