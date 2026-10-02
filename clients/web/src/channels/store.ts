import {
  MessageDeletedPush,
  MessageEditedPush,
  MessagePostedPush,
  ReactionChangedPush,
  ReadStateEntry,
  TypingStartedPush,
  type ChannelMessage,
  type FileSummary,
  type Message,
  type ReactionSummary,
} from '@manythreads/shared';
import { z } from 'zod';
import { isApiError } from '../api/client';
import {
  addReaction,
  deleteMessage,
  editMessage,
  fetchMessage,
  fetchMessages,
  fetchReadStates,
  fetchThread,
  fetchUnreadSummary,
  markRead,
  postMessage,
  removeReaction,
} from '../api/endpoints';
import type { Push, RealtimeClient } from '../realtime/socket';
import {
  applyReaction,
  emptyTimeline,
  fromPage,
  mergeItems,
  patchMessage,
  removeMessage,
  type PendingSend,
  type Timeline,
} from './timeline';

/*
 * The small client store behind the channel view, the thread panel and the sidebar badges (PLAN P3-13). It owns the loaded
 * timelines, applies the WebSocket pushes to them, keeps unread counts, and does the writes (optimistic send with retry, edit,
 * delete, react). React reads it through `useSyncExternalStore`: every change replaces the timeline object it touched, so a
 * component re-renders only when its own slice moved.
 */

export const channelKey = (channelId: string): string => `c:${channelId}`;
export const threadKey = (rootId: string): string => `t:${rootId}`;

const READ_PUSH = ReadStateEntry.extend({ reason: z.enum(['posted', 'read', 'followed']).optional() });
const PAGE = 50;
const OLDER_PAGE = 100;
const TYPING_GRACE_MS = 250;

export type TypingEntry = { personId: string; until: number };
export type Snapshot = {
  /** Unread messages per channel, from the sidebar directory, the unread summary and live read-state pushes. */
  unread: Readonly<Record<string, number>>;
  /** Threads with unread replies (the Threads badge). */
  threadsUnread: number;
};

const EMPTY: Timeline = emptyTimeline();
const NO_TYPING: TypingEntry[] = [];
const idOf = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** The `ChannelMessage` for a message the server just accepted (a POST answers a bare `Message`). */
export function asChannelMessage(m: Message, attachments?: FileSummary[]): ChannelMessage {
  return { ...m, reactions: [], replyCount: 0, lastReplyAt: null, ...(attachments && attachments.length > 0 ? { attachments } : {}) };
}

/** A pushed message carries the sender's `mine` flags, which mean nothing to the reader: they start false. */
const forReader = (m: ChannelMessage): ChannelMessage => ({ ...m, reactions: m.reactions.map((r) => ({ ...r, mine: false })) });

export class ChannelStore {
  private timelines = new Map<string, Timeline>();
  private readStates = new Map<string, ReadStateEntry>();
  private typing = new Map<string, TypingEntry[]>();
  private snap: Snapshot = { unread: {}, threadsUnread: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly counted = new Set<string>();
  private self: string | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncHooks = new Set<() => void>();
  private detach: Array<() => void> = [];

  // ---- subscription -------------------------------------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  get = (key: string): Timeline => this.timelines.get(key) ?? EMPTY;
  snapshot = (): Snapshot => this.snap;
  readState = (targetKey: string): ReadStateEntry | undefined => this.readStates.get(targetKey);
  typingIn = (key: string): TypingEntry[] => this.typing.get(key) ?? NO_TYPING;

  /** The reader's actor id (from the roster): it decides whose reaction is "mine" and which messages are own. */
  setSelf(actorId: string | null): void {
    this.self = actorId;
  }
  get selfActor(): string | null {
    return this.self;
  }

  private put(key: string, next: Timeline | ((t: Timeline) => Timeline)): void {
    const cur = this.timelines.get(key) ?? emptyTimeline();
    this.timelines.set(key, typeof next === 'function' ? next(cur) : next);
    this.emit();
  }

  // ---- realtime wiring --------------------------------------------------------------------------------
  /** Listen to the tab's socket: pushes go into the timelines, a reconnect refetches what was missed. */
  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [client.onPush((p) => this.handlePush(p)), client.onReconnected(() => void this.resync())];
  }
  /** A hook for the sidebar directory, which lives outside the store: called after a reconnect and when a channel is created. */
  onResync(cb: () => void): () => void {
    this.resyncHooks.add(cb);
    return () => this.resyncHooks.delete(cb);
  }

  handlePush(push: Push): void {
    switch (push.type) {
      case 'message.posted': {
        const p = MessagePostedPush.safeParse(push.payload);
        if (p.success) void this.onPosted(p.data);
        return;
      }
      case 'message.edited': {
        const p = MessageEditedPush.safeParse(push.payload);
        if (p.success) void this.onEdited(p.data);
        return;
      }
      case 'message.deleted': {
        const p = MessageDeletedPush.safeParse(push.payload);
        if (p.success) this.onDeleted(p.data.channelId, p.data.messageId, p.data.threadRootId);
        return;
      }
      case 'reaction.changed': {
        const p = ReactionChangedPush.safeParse(push.payload);
        if (p.success) this.onReaction(p.data);
        return;
      }
      case 'typing.started': {
        const p = TypingStartedPush.safeParse(push.payload);
        if (p.success) this.onTyping(p.data.channelId, p.data.threadRootId, p.data.personId, Date.parse(p.data.expiresAt));
        return;
      }
      case 'channel.created':
        for (const h of [...this.resyncHooks]) h();
        return;
      case 'reading.state.changed': {
        const p = READ_PUSH.safeParse(push.payload);
        if (p.success) this.onReadState(p.data);
        return;
      }
      default:
        return;
    }
  }

  // ---- messages in ----------------------------------------------------------------------------------------
  private async onPosted(p: MessagePostedPush): Promise<void> {
    let message = p.message;
    if (!message) {
      try {
        message = await fetchMessage(p.channelId, p.messageId);
      } catch {
        return;
      }
    }
    this.applyPosted(forReader(message));
  }

  /** A message arrived (push, or the answer to our own POST): into its timeline, counted once, pending copy dropped. */
  applyPosted(message: ChannelMessage, localId?: string): void {
    const root = message.threadRootId;
    const key = root ? threadKey(root) : channelKey(message.channelId);
    const mine = this.self !== null && message.authorId === this.self;
    const existing = this.timelines.get(key);
    if (existing) {
      this.put(key, (t) => ({
        ...t,
        // already held (the push and the answer to our own POST both arrive): keep its reactions and counts, take the text
        items: t.items.some((m) => m.id === message.id)
          ? patchMessage(t.items, message.id, (m) => ({ ...m, body: message.body, bodyPlain: message.bodyPlain, editedAt: message.editedAt }))
          : mergeItems(t.items, [message]),
        pending: t.pending.filter((x) => x.localId !== localId && !(mine && x.status === 'sending' && x.body === message.body)),
      }));
    }
    if (root && !this.counted.has(message.id)) {
      this.counted.add(message.id);
      if (this.counted.size > 5_000) this.counted.delete(this.counted.values().next().value as string);
      const chan = this.timelines.get(channelKey(message.channelId));
      if (chan) this.put(channelKey(message.channelId), (t) => ({ ...t, items: patchMessage(t.items, root, (m) => ({ ...m, replyCount: m.replyCount + 1, lastReplyAt: message.createdAt })) }));
      const thread = this.timelines.get(threadKey(root));
      if (thread?.root) this.put(threadKey(root), (t) => (t.root ? { ...t, root: { ...t.root, replyCount: t.root.replyCount + 1, lastReplyAt: message.createdAt } } : t));
    }
  }

  private async onEdited(p: MessageEditedPush): Promise<void> {
    let message = p.message;
    if (!message) {
      try {
        message = await fetchMessage(p.channelId, p.messageId);
      } catch {
        return;
      }
    }
    const next = message;
    this.mapMessage(next.channelId, next.threadRootId, next.id, (m) => ({ ...m, body: next.body, bodyPlain: next.bodyPlain, editedAt: next.editedAt }));
  }

  private onDeleted(channelId: string, messageId: string, rootId: string | null): void {
    const at = new Date().toISOString();
    if (rootId === null) {
      if (this.timelines.has(channelKey(channelId))) this.put(channelKey(channelId), (t) => ({ ...t, items: removeMessage(t.items, messageId, at) }));
      const th = this.timelines.get(threadKey(messageId));
      if (th?.root) this.put(threadKey(messageId), (t) => (t.root ? { ...t, root: { ...t.root, body: '[deleted]', bodyPlain: '', deletedAt: at, reactions: [] } } : t));
      return;
    }
    const gone = this.timelines.get(threadKey(rootId))?.items.some((m) => m.id === messageId) ?? false;
    if (this.timelines.has(threadKey(rootId))) this.put(threadKey(rootId), (t) => ({ ...t, items: t.items.filter((m) => m.id !== messageId), root: t.root ? { ...t.root, replyCount: Math.max(0, t.root.replyCount - 1) } : t.root }));
    if (gone || this.counted.delete(messageId)) {
      if (this.timelines.has(channelKey(channelId))) this.put(channelKey(channelId), (t) => ({ ...t, items: patchMessage(t.items, rootId, (m) => ({ ...m, replyCount: Math.max(0, m.replyCount - 1) })) }));
    }
  }

  private onReaction(p: ReactionChangedPush): void {
    const byMe = this.self !== null && p.actorId === this.self;
    this.mapMessageAnywhere(p.channelId, p.messageId, (m) => ({ ...m, reactions: applyReaction(m.reactions, { emoji: p.emoji, count: p.count, added: p.added, byMe }) }));
  }

  private onTyping(channelId: string, rootId: string | null, personId: string, until: number): void {
    const key = rootId ? threadKey(rootId) : channelKey(channelId);
    const now = Date.now();
    const list = (this.typing.get(key) ?? []).filter((t) => t.personId !== personId && t.until > now);
    list.push({ personId, until });
    this.typing.set(key, list);
    this.emit();
    setTimeout(() => {
      const left = (this.typing.get(key) ?? []).filter((t) => t.until > Date.now());
      this.typing.set(key, left);
      this.emit();
    }, Math.max(0, until - now) + TYPING_GRACE_MS);
  }

  private onReadState(p: z.infer<typeof READ_PUSH>): void {
    this.readStates.set(`${p.targetType}:${p.targetId}`, ReadStateEntry.parse(p));
    if (p.targetType === 'channel') this.setUnread(p.targetId, p.unreadCount);
    else {
      const th = this.timelines.get(threadKey(p.targetId));
      if (th?.thread) this.put(threadKey(p.targetId), (t) => (t.thread ? { ...t, thread: { ...t.thread, followed: p.followed, unreadCount: p.unreadCount, lastReadId: p.lastReadId } } : t));
      this.refreshSummarySoon();
    }
  }

  /** Apply `fn` to one message in the timeline that holds it (channel or thread, and the thread's root). */
  private mapMessage(channelId: string, rootId: string | null, id: string, fn: (m: ChannelMessage) => ChannelMessage): void {
    if (rootId === null) {
      if (this.timelines.has(channelKey(channelId))) this.put(channelKey(channelId), (t) => ({ ...t, items: patchMessage(t.items, id, fn) }));
      if (this.timelines.get(threadKey(id))?.root) this.put(threadKey(id), (t) => (t.root ? { ...t, root: fn(t.root) } : t));
    } else if (this.timelines.has(threadKey(rootId))) {
      this.put(threadKey(rootId), (t) => ({ ...t, items: patchMessage(t.items, id, fn) }));
    }
  }
  /** Same, when the message's place is not known (a reaction push does not say whether it is a reply). */
  private mapMessageAnywhere(channelId: string, id: string, fn: (m: ChannelMessage) => ChannelMessage): void {
    const chan = this.timelines.get(channelKey(channelId));
    if (chan?.items.some((m) => m.id === id)) this.mapMessage(channelId, null, id, fn);
    for (const [key, t] of this.timelines) {
      if (!key.startsWith('t:')) continue;
      if (t.items.some((m) => m.id === id)) this.put(key, (x) => ({ ...x, items: patchMessage(x.items, id, fn) }));
      else if (t.root?.id === id) this.put(key, (x) => (x.root ? { ...x, root: fn(x.root) } : x));
    }
  }

  // ---- loading ------------------------------------------------------------------------------------------------
  /** Open a channel: the newest page. A channel already held is refreshed in place (no flash of "loading"). */
  async loadChannel(channelId: string): Promise<void> {
    const key = channelKey(channelId);
    const had = this.timelines.get(key);
    if (!had || had.status === 'error') this.put(key, emptyTimeline());
    try {
      const page = await fetchMessages(channelId, { limit: PAGE });
      this.put(key, (t) => this.merged(t, page.items, page.nextCursor, PAGE));
    } catch (e) {
      this.put(key, (t) => (t.items.length > 0 ? t : { ...t, status: 'error', error: errorOf(e) }));
    }
  }

  /** Merge a newest-first page into a timeline; a page that does not reach back to what is held replaces it (a gap). */
  private merged(t: Timeline, page: readonly ChannelMessage[], nextCursor: string | null, limit: number): Timeline {
    const fresh = fromPage(page);
    const newestHeld = t.items.at(-1)?.id;
    const gap = newestHeld !== undefined && page.length >= limit && (fresh[0]?.id ?? '') > newestHeld;
    if (t.items.length === 0 || gap) return { ...t, status: 'ready', error: null, items: fresh, cursor: nextCursor };
    return { ...t, status: 'ready', error: null, items: mergeItems(t.items, fresh) };
  }

  async loadOlder(key: string, channelId: string, rootId: string | null): Promise<void> {
    const t = this.get(key);
    if (!t.cursor || t.loadingOlder || t.status !== 'ready') return;
    this.put(key, (x) => ({ ...x, loadingOlder: true }));
    try {
      const page = await fetchMessages(channelId, { before: t.cursor, limit: OLDER_PAGE, ...(rootId ? { threadRootId: rootId } : {}) });
      this.put(key, (x) => ({ ...x, loadingOlder: false, items: mergeItems(x.items, fromPage(page.items)), cursor: page.nextCursor }));
    } catch {
      this.put(key, (x) => ({ ...x, loadingOlder: false }));
    }
  }

  /**
   * Open a thread in the panel. The threads plugin answers with the root, the caller's state and the first replies. A server
   * without that plugin has no such route: with the channel known (the panel sits beside it) the channel API gives the same.
   */
  async loadThread(rootId: string, channelHint: string | null): Promise<void> {
    const key = threadKey(rootId);
    const had = this.timelines.get(key);
    if (!had || had.status === 'error') this.put(key, emptyTimeline());
    try {
      const r = await fetchThread(rootId, { limit: PAGE });
      this.put(key, (t) => ({ ...this.merged(t, r.replies.items, r.replies.nextCursor, PAGE), channel: r.channel, root: r.root, thread: r.thread }));
    } catch (e) {
      if (isApiError(e) && e.status === 404 && channelHint) {
        try {
          const [root, page] = await Promise.all([fetchMessage(channelHint, rootId), fetchMessages(channelHint, { limit: PAGE, threadRootId: rootId })]);
          this.put(key, (t) => ({ ...this.merged(t, page.items, page.nextCursor, PAGE), root, thread: t.thread }));
          return;
        } catch (e2) {
          this.put(key, (t) => (t.items.length > 0 || t.root ? t : { ...t, status: 'error', error: errorOf(e2) }));
          return;
        }
      }
      this.put(key, (t) => (t.items.length > 0 || t.root ? t : { ...t, status: 'error', error: errorOf(e) }));
    }
  }

  /** After a reconnect: every open timeline gets its newest page again, the badges are recounted. */
  async resync(): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    for (const [key, t] of this.timelines) {
      if (t.status !== 'ready') continue;
      if (key.startsWith('c:')) jobs.push(this.loadChannel(key.slice(2)));
      else if (t.channel || t.root) jobs.push(this.loadThread(key.slice(2), t.root?.channelId ?? t.channel?.id ?? null));
    }
    for (const h of [...this.resyncHooks]) h();
    jobs.push(this.refreshSummary());
    await Promise.allSettled(jobs);
  }

  // ---- unread ------------------------------------------------------------------------------------------------
  private setUnread(channelId: string, n: number): void {
    if (this.snap.unread[channelId] === n) return;
    this.snap = { ...this.snap, unread: { ...this.snap.unread, [channelId]: n } };
    this.emit();
  }

  /** The sidebar directory's counts (every channel it lists). */
  seedUnread(channels: ReadonlyArray<{ id: string; unread: number }>): void {
    const unread = { ...this.snap.unread };
    for (const c of channels) unread[c.id] = c.unread;
    this.snap = { ...this.snap, unread };
    this.emit();
  }

  async refreshSummary(): Promise<void> {
    try {
      const s = await fetchUnreadSummary();
      const unread = { ...this.snap.unread };
      for (const id of Object.keys(unread)) if (!s.channels.some((c) => c.channelId === id)) unread[id] = 0;
      for (const c of s.channels) unread[c.channelId] = c.unreadCount;
      this.snap = { unread, threadsUnread: s.threads.threadCount };
      this.emit();
    } catch {
      /* no read-state plugin, or signed out: the badges stay as they were */
    }
  }
  private refreshSummarySoon(): void {
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      void this.refreshSummary();
    }, 400);
  }

  /** Where the person had read up to (for the unread divider). */
  async loadReadState(targetType: 'channel' | 'thread', targetId: string): Promise<ReadStateEntry | null> {
    try {
      const r = await fetchReadStates(`${targetType}:${targetId}`);
      const entry = r.states[0] ?? null;
      if (entry) {
        this.readStates.set(`${targetType}:${targetId}`, entry);
        if (targetType === 'channel') this.setUnread(targetId, entry.unreadCount);
      }
      return entry;
    } catch {
      return null;
    }
  }

  /** The person has seen everything up to `upTo` in this channel or thread. */
  async markRead(targetType: 'channel' | 'thread', targetId: string, upTo: string): Promise<void> {
    const had = this.readStates.get(`${targetType}:${targetId}`);
    if (had?.lastReadId && had.lastReadId >= upTo) return;
    try {
      const entry = await markRead(targetType, targetId, upTo);
      this.readStates.set(`${targetType}:${targetId}`, entry);
      if (targetType === 'channel') this.setUnread(targetId, entry.unreadCount);
      else {
        this.put(threadKey(targetId), (t) => (t.thread ? { ...t, thread: { ...t.thread, unreadCount: entry.unreadCount, lastReadId: entry.lastReadId } } : t));
        this.refreshSummarySoon();
      }
    } catch {
      /* try again when the reader scrolls or the next push arrives */
    }
  }

  // ---- writes ------------------------------------------------------------------------------------------------
  /** Optimistic send: the message shows at once as "sending"; on failure it stays with "Not sent · Retry". */
  async send(channelId: string, rootId: string | null, body: string, attachments: FileSummary[] = []): Promise<void> {
    const key = rootId ? threadKey(rootId) : channelKey(channelId);
    const item: PendingSend = { localId: idOf(), body, attachments, status: 'sending', createdAt: new Date().toISOString() };
    this.put(key, (t) => ({ ...t, pending: [...t.pending, item] }));
    await this.deliver(key, channelId, rootId, item);
  }

  retry(channelId: string, rootId: string | null, localId: string): Promise<void> {
    const key = rootId ? threadKey(rootId) : channelKey(channelId);
    const item = this.get(key).pending.find((p) => p.localId === localId);
    if (!item) return Promise.resolve();
    this.put(key, (t) => ({ ...t, pending: t.pending.map((p) => (p.localId === localId ? { ...p, status: 'sending' } : p)) }));
    return this.deliver(key, channelId, rootId, item);
  }

  discard(channelId: string, rootId: string | null, localId: string): void {
    const key = rootId ? threadKey(rootId) : channelKey(channelId);
    this.put(key, (t) => ({ ...t, pending: t.pending.filter((p) => p.localId !== localId) }));
  }

  private async deliver(key: string, channelId: string, rootId: string | null, item: PendingSend): Promise<void> {
    try {
      const m = await postMessage(channelId, item.body, rootId, item.attachments.map((a) => a.id));
      this.applyPosted(asChannelMessage(m, item.attachments), item.localId);
      // the push may have come first and already removed the pending copy; either way it is gone now
      this.put(key, (t) => ({ ...t, pending: t.pending.filter((p) => p.localId !== item.localId) }));
    } catch {
      this.put(key, (t) => ({ ...t, pending: t.pending.map((p) => (p.localId === item.localId ? { ...p, status: 'failed' } : p)) }));
    }
  }

  async edit(channelId: string, rootId: string | null, id: string, body: string): Promise<void> {
    const m = await editMessage(channelId, id, body);
    this.mapMessage(channelId, rootId, id, (x) => ({ ...x, body: m.body, bodyPlain: m.bodyPlain, editedAt: m.editedAt }));
  }

  async remove(channelId: string, rootId: string | null, id: string): Promise<void> {
    await deleteMessage(channelId, id);
    this.onDeleted(channelId, id, rootId);
  }

  /** Toggle my reaction: shown at once, then settled with what the server answers. */
  async toggleReaction(channelId: string, rootId: string | null, id: string, emoji: string): Promise<void> {
    const current = this.findMessage(channelId, rootId, id)?.reactions.find((r) => r.emoji === emoji);
    const adding = !current?.mine;
    const optimistic = (reactions: readonly ReactionSummary[]): ReactionSummary[] =>
      applyReaction(reactions, { emoji, count: Math.max(0, (current?.count ?? 0) + (adding ? 1 : -1)), added: adding, byMe: true });
    this.mapMessage(channelId, rootId, id, (m) => ({ ...m, reactions: optimistic(m.reactions) }));
    try {
      const res = adding ? await addReaction(channelId, id, emoji) : await removeReaction(channelId, id, emoji);
      this.mapMessage(channelId, rootId, id, (m) => ({ ...m, reactions: res.reactions }));
    } catch {
      this.mapMessage(channelId, rootId, id, (m) => ({ ...m, reactions: current ? applyReaction(m.reactions, { emoji, count: current.count, added: current.mine, byMe: true }) : applyReaction(m.reactions, { emoji, count: 0, added: false, byMe: true }) }));
    }
  }

  private findMessage(channelId: string, rootId: string | null, id: string): ChannelMessage | undefined {
    if (rootId === null) return this.timelines.get(channelKey(channelId))?.items.find((m) => m.id === id) ?? this.timelines.get(threadKey(id))?.root ?? undefined;
    return this.timelines.get(threadKey(rootId))?.items.find((m) => m.id === id);
  }

  /** Follow state of an open thread, after the follow route answered. */
  setFollowed(rootId: string, followed: boolean): void {
    if (this.timelines.has(threadKey(rootId))) this.put(threadKey(rootId), (t) => (t.thread ? { ...t, thread: { ...t.thread, followed } } : t));
  }
}

function errorOf(e: unknown): { status: number; message: string } {
  return isApiError(e) ? { status: e.status, message: e.message } : { status: 0, message: e instanceof Error ? e.message : 'Something went wrong' };
}

/** The app's store. */
export const channelStore = new ChannelStore();
