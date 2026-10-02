import type { ChannelMessage, FileSummary, ReactionSummary, ThreadChannelRef, ThreadState } from '@manythreads/shared';

/*
 * What the channel view and the thread panel show, as plain data with pure updates (the store applies them; the tests call them
 * directly). A timeline is the messages of one channel (no replies) or of one thread (the replies), oldest first: ids are uuid v7,
 * so id order is time order.
 */

export type PendingSend = { localId: string; body: string; attachments: FileSummary[]; status: 'sending' | 'failed'; createdAt: string };

export type Timeline = {
  /** Oldest first. */
  items: ChannelMessage[];
  status: 'loading' | 'ready' | 'error';
  error: { status: number; message: string } | null;
  /** The `before` for the next older page; null when everything older is held. */
  cursor: string | null;
  loadingOlder: boolean;
  pending: PendingSend[];
  /** Threads only: the channel the thread lives in, its root message and what the caller knows about it. */
  channel: ThreadChannelRef | null;
  root: ChannelMessage | null;
  thread: ThreadState | null;
};

export const emptyTimeline = (): Timeline => ({ items: [], status: 'loading', error: null, cursor: null, loadingOlder: false, pending: [], channel: null, root: null, thread: null });

export const TOMBSTONE = '[deleted]';

const byId = (a: ChannelMessage, b: ChannelMessage): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Merge messages into an oldest-first list: a message that is already held is replaced, the rest are inserted in order. */
export function mergeItems(held: readonly ChannelMessage[], incoming: readonly ChannelMessage[]): ChannelMessage[] {
  if (incoming.length === 0) return held as ChannelMessage[];
  const map = new Map(held.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byId);
}

/** A page from the API (newest first) as oldest-first items. */
export const fromPage = (items: readonly ChannelMessage[]): ChannelMessage[] => [...items].sort(byId);

export function patchMessage(items: readonly ChannelMessage[], id: string, patch: (m: ChannelMessage) => ChannelMessage): ChannelMessage[] {
  const i = items.findIndex((m) => m.id === id);
  if (i < 0) return items as ChannelMessage[];
  const next = items.slice();
  next[i] = patch(items[i] as ChannelMessage);
  return next;
}

/** A deleted message stays as a tombstone while it holds a thread, otherwise it goes. */
export function removeMessage(items: readonly ChannelMessage[], id: string, deletedAt: string): ChannelMessage[] {
  const m = items.find((x) => x.id === id);
  if (!m) return items as ChannelMessage[];
  if (m.replyCount > 0) return patchMessage(items, id, (x) => ({ ...x, body: TOMBSTONE, bodyPlain: '', deletedAt, reactions: [] }));
  return items.filter((x) => x.id !== id);
}

/** One reaction changed by someone: set the count; `mine` only moves when the actor is the reader. */
export function applyReaction(
  reactions: readonly ReactionSummary[],
  change: { emoji: string; count: number; added: boolean; byMe: boolean },
): ReactionSummary[] {
  const i = reactions.findIndex((r) => r.emoji === change.emoji);
  if (change.count <= 0) return reactions.filter((r) => r.emoji !== change.emoji);
  if (i < 0) return [...reactions, { emoji: change.emoji, count: change.count, mine: change.byMe && change.added }];
  const next = reactions.slice();
  const old = reactions[i] as ReactionSummary;
  next[i] = { ...old, count: change.count, mine: change.byMe ? change.added : old.mine };
  return next;
}

/** The position of the unread divider: the index of the first message newer than `lastReadId` that is not the reader's own. */
export function firstUnreadIndex(items: readonly ChannelMessage[], lastReadId: string | null, selfActorId: string | null, allLoaded: boolean): number {
  if (lastReadId === null && !allLoaded) return -1;
  const i = items.findIndex((m) => (lastReadId === null || m.id > lastReadId) && m.deletedAt === null && m.authorId !== selfActorId);
  return i;
}
