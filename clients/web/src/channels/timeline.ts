import type { ChannelMessage, FileSummary, ReactionSummary, ThreadChannelRef, ThreadState, VoiceMeta } from '@manythreads/shared';

/*
 * What the channel view and the thread panel show, as plain data with pure updates (the store applies them; the tests call them
 * directly). A timeline is the messages of one channel (no replies) or of one thread (the replies), oldest first: ids are uuid v7,
 * so id order is time order.
 */

export type PendingSend = {
  localId: string;
  body: string;
  attachments: FileSummary[];
  status: 'sending' | 'failed';
  createdAt: string;
  alsoToChannel?: boolean;
  confirmBroadcast?: boolean;
  /** A voice message (P14-17): the clip is `attachments[0]`; kept so a retry sends the same meta. */
  voice?: VoiceMeta;
  /** Set on a failed send that the server refused only because `@channel` / `@here` would notify a big room: its sentence ("@channel will notify 52 people."). "Send anyway" confirms it. */
  askConfirm?: string;
};

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
  for (const m of incoming) {
    const old = map.get(m.id);
    // a pushed copy has no reply preview (P21-03): keep the one the held message carries
    map.set(m.id, old && (m.replyAuthors === undefined || m.unreadReplies === undefined) ? keepReplyPreview(m, old) : m);
  }
  return [...map.values()].sort(byId);
}

function keepReplyPreview(m: ChannelMessage, old: ChannelMessage): ChannelMessage {
  const next = { ...m };
  if (m.replyAuthors === undefined && old.replyAuthors !== undefined) next.replyAuthors = old.replyAuthors;
  if (m.unreadReplies === undefined && old.unreadReplies !== undefined) next.unreadReplies = old.unreadReplies;
  return next;
}

/**
 * A reply arrived for a thread root (P21-03): its author goes first in the root's preview (no repeats, at most three); the reader's own reply
 * does not make the thread unread.
 */
export function withReply(root: ChannelMessage, reply: { author?: ChannelMessage['author'] | undefined }, own: boolean): ChannelMessage {
  const author = reply.author;
  const held = root.replyAuthors ?? [];
  const replyAuthors = author ? [author, ...held.filter((a) => a.actorId !== author.actorId)].slice(0, 3) : held;
  return { ...root, replyAuthors, unreadReplies: own ? (root.unreadReplies ?? false) : true };
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
