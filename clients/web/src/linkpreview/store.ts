import { LinkPreviewChangedPush, WS_LINK_PREVIEW_CHANGED, type LinkPreview } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchLinkPreviews, removeLinkPreview } from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import type { Push, RealtimeClient } from '../realtime/socket';

/*
 * The cards under messages (PLAN P14-08, docs/plugins/link-preview.md). A message row that carries a link asks for its cards; the asks of one
 * moment (a screenful of rows mounting) leave as one request per channel, up to 100 messages each. The server is the truth: the card list of a
 * message is replaced as a whole by each answer, and a `link-preview.changed` push (a card was made, pruned or removed) asks again for that
 * message when a row still shows it. A server without the plugin answers 404 once and the store stops asking.
 *
 * Room for a card (`pending`) is kept only while a card can really come: while the first answer is on its way, and after it only for a message the server
 * names as pending (a new message with a link no card exists for yet), and then for at most `PENDING_HOLD_MS`. A server or workspace that does not read links
 * says so in each answer (`enabled: false`) and the store stops asking, and holds no room, for a few minutes: nothing moves when nothing can come.
 */

export interface MessageCards {
  /** The cards to draw, in the order of the links in the message. */
  cards: readonly LinkPreview[];
  /** Asked for and not yet answered: the row keeps room for a card so one that arrives does not move the rows below it. */
  pending: boolean;
}

const NONE: MessageCards = { cards: [], pending: false };
const WAITING: MessageCards = { cards: [], pending: true };
/** A card that is being made arrives within seconds; a row that has waited this long gives its room back. */
export const PENDING_HOLD_MS = 20_000;
/** After the server said it reads no links, the store does not ask again for this long. */
export const OFF_MS = 5 * 60_000;
const BATCH_MS = 40;
const MAX_BATCH = 100;
const KEEP = 2_000;

export class LinkPreviewStore {
  private readonly state = new Map<string, MessageCards>();
  private readonly channelOf = new Map<string, string>();
  /** How many rows show each message right now (the message list and an open thread can show the same one). */
  private readonly shown = new Map<string, number>();
  private readonly queue = new Map<string, Set<string>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private supported = true;
  private offUntil = 0;
  private readonly holds = new Map<string, ReturnType<typeof setTimeout>>();
  private detach: Array<() => void> = [];

  subscribe = (messageId: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(messageId);
    if (!set) this.listeners.set(messageId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(messageId);
    };
  };

  cardsOf = (messageId: string): MessageCards => this.state.get(messageId) ?? NONE;

  private put(messageId: string, next: MessageCards): void {
    this.state.set(messageId, next);
    for (const l of [...(this.listeners.get(messageId) ?? [])]) l();
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.holds.values()) clearTimeout(t);
    this.holds.clear();
    this.offUntil = 0;
    this.queue.clear();
    this.state.clear();
    this.channelOf.clear();
    this.shown.clear();
    this.supported = true;
    for (const set of [...this.listeners.values()]) for (const l of [...set]) l();
  }

  /** A row shows this message and wants its cards. Call the returned function when the row goes away. */
  want(channelId: string, messageId: string): () => void {
    this.channelOf.set(messageId, channelId);
    const rowsBefore = this.shown.get(messageId) ?? 0;
    this.shown.set(messageId, rowsBefore + 1);
    if (this.offUntil > Date.now()) {
      // the server reads no links: nothing to ask, no room to keep
      if (!this.state.has(messageId)) this.state.set(messageId, NONE);
    } else if (this.supported && !this.state.has(messageId)) {
      this.put(messageId, WAITING);
      this.ask(channelId, messageId);
    } else if (this.supported && rowsBefore === 0) {
      // kept from an earlier look: the message may have changed while no row showed it (pushes are only followed for shown rows)
      this.ask(channelId, messageId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.shown.get(messageId) ?? 1) - 1;
      if (left > 0) this.shown.set(messageId, left);
      else this.shown.delete(messageId);
      if (this.state.size > KEEP) this.prune();
    };
  }

  private prune(): void {
    for (const id of [...this.state.keys()]) {
      if (this.state.size <= KEEP / 2) break;
      if (!this.shown.has(id) && !this.listeners.has(id)) {
        this.state.delete(id);
        this.channelOf.delete(id);
      }
    }
  }

  private ask(channelId: string, messageId: string): void {
    let ids = this.queue.get(channelId);
    if (!ids) this.queue.set(channelId, (ids = new Set()));
    ids.add(messageId);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, BATCH_MS);
  }

  private async flush(): Promise<void> {
    const jobs = [...this.queue.entries()];
    this.queue.clear();
    for (const [channelId, set] of jobs) {
      const all = [...set];
      for (let i = 0; i < all.length; i += MAX_BATCH) {
        await this.load(channelId, all.slice(i, i + MAX_BATCH));
      }
    }
  }

  private async load(channelId: string, ids: string[]): Promise<void> {
    try {
      const res = await fetchLinkPreviews(channelId, ids);
      const by = new Map<string, LinkPreview[]>();
      for (const card of res.items) by.set(card.messageId, [...(by.get(card.messageId) ?? []), card]);
      if (!res.enabled) this.offUntil = Date.now() + OFF_MS;
      else this.offUntil = 0;
      const waiting = new Set<string>(res.pending);
      for (const id of ids) this.settle(id, by.get(id) ?? [], waiting.has(id));
    } catch (e) {
      // no plugin on this server: stop asking; any other failure (a lost channel, a dropped connection) only leaves the rows as they were
      if (isApiError(e) && e.status === 404) this.supported = false;
      for (const id of ids) this.put(id, { cards: this.cardsOf(id).cards, pending: false });
    }
  }

  /** Stores an answer for one message; keeps room for a card only if the server says one is on its way, and only for a while. */
  private settle(messageId: string, cards: readonly LinkPreview[], waiting: boolean): void {
    const old = this.holds.get(messageId);
    if (old) clearTimeout(old);
    this.holds.delete(messageId);
    const hold = waiting && cards.length === 0;
    this.put(messageId, { cards, pending: hold });
    if (!hold) return;
    this.holds.set(
      messageId,
      setTimeout(() => {
        this.holds.delete(messageId);
        this.put(messageId, { cards: this.cardsOf(messageId).cards, pending: false });
      }, PENDING_HOLD_MS),
    );
  }

  /** Reads this message's cards again (a push said they changed). A message no row shows is left alone: it is read when a row asks. */
  refresh(messageId: string): void {
    const channelId = this.channelOf.get(messageId);
    if (!this.supported || channelId === undefined || !this.shown.has(messageId)) return;
    this.ask(channelId, messageId);
  }

  /** The author removes a card: it disappears at once and comes back if the server refuses. Rejects with the server's sentence. */
  async remove(card: LinkPreview): Promise<void> {
    const before = this.cardsOf(card.messageId);
    this.put(card.messageId, { cards: before.cards.filter((c) => c.id !== card.id), pending: false });
    try {
      await removeLinkPreview(card.channelId, card.messageId, card.id);
    } catch (e) {
      this.put(card.messageId, before);
      throw e;
    }
  }

  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [
      client.onPush((p) => this.handlePush(p)),
      // what changed while the socket was down is unknown: ask again for every message a row shows
      client.onReconnected(() => {
        for (const id of this.shown.keys()) this.refresh(id);
      }),
    ];
  }

  handlePush(push: Push): void {
    if (push.type !== WS_LINK_PREVIEW_CHANGED) return;
    const p = LinkPreviewChangedPush.safeParse(push.payload);
    if (p.success) this.refresh(p.data.messageId);
  }
}

export const linkPreviewStore = new LinkPreviewStore();
onPersonChange(() => linkPreviewStore.reset());
