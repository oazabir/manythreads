import { useEffect, useSyncExternalStore } from 'react';
import { CALL_CARDS_MAX, ListCallCardsResponse, listCallCardsRoute, type CallCard } from '@manythreads/shared';
import { call } from '../api/client';
import { isMockMode } from '../api/setup';
import { onPersonChange } from '../app/caches';

/*
 * The call cards of the start messages in view (P15-26). A row with `meta.meeting` asks for its call; the asks of 100 ms are sent together to
 * `GET /api/meetings/cards?ids=` (at most 50 a request). A call the server leaves out (the reader cannot read it) is `gone`: the row keeps its one-line start. A
 * `meeting.changed` push asks again for that one call only (wired in `meetings/store.ts` next to `onRoomChanged`); a call the page never drew is not asked for.
 */

export type CardEntry =
  | { status: 'loading' }
  | { status: 'ok'; card: CallCard }
  /** Not answered: the reader cannot read the call. */
  | { status: 'gone' }
  /**
   * The ask failed (offline, a 429, a server without the route): the row shows its one-line start. A row drawn again asks again once `retryAt` has passed
   * (the wait doubles each time, up to a minute, so a refused ask does not loop); a push or the socket coming back asks again at once.
   */
  | { status: 'failed'; tries: number; retryAt: number };

export type CallCardsDeps = {
  fetchCards: (ids: readonly string[]) => Promise<{ cards: CallCard[] }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
};

/** The first wait before a failed card is asked again on a redraw, and the longest. */
export const CARD_RETRY_MS = 2_000;
export const CARD_RETRY_MAX_MS = 60_000;

/** How long the store waits for more rows to ask before it sends one request. */
export const CARD_BATCH_MS = 100;

const LOADING: CardEntry = { status: 'loading' };

export class CallCardsStore {
  private readonly entries = new Map<string, CardEntry>();
  private readonly listeners = new Set<() => void>();
  /** Ids to send with the next request. */
  private queue = new Set<string>();
  private timer: unknown = null;
  /** The number of the newest request that asked for each id: an older answer that comes in later is dropped. */
  private readonly askedIn = new Map<string, number>();
  private batch = 0;
  /** Promises for "a fresh answer for this id", for End call to wait on. */
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly deps: CallCardsDeps) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get = (meetingId: string): CardEntry | undefined => this.entries.get(meetingId);

  /** The card, when it has been answered. */
  card(meetingId: string): CallCard | null {
    const e = this.entries.get(meetingId);
    return e?.status === 'ok' ? e.card : null;
  }

  /** The calls whose answered card says live. */
  liveCardIds(): string[] {
    const out: string[] = [];
    for (const [id, e] of this.entries) if (e.status === 'ok' && e.card.state === 'live') out.push(id);
    return out;
  }

  /**
   * The live list of the page changed: a card drawn as live whose call the list no longer has is asked again, so a lost push heals with the half-minute check
   * of the live list.
   */
  liveListChanged(liveIds: ReadonlySet<string>): void {
    for (const id of this.liveCardIds()) if (!liveIds.has(id)) this.enqueue(id);
  }

  /** A row with this call came into view: ask for it once (a known card is not asked again; a failed one only after its wait). */
  want(meetingId: string): void {
    const e = this.entries.get(meetingId);
    if (e?.status === 'failed') {
      if (this.deps.now() >= e.retryAt) this.enqueue(meetingId);
      return;
    }
    if (e) return;
    this.entries.set(meetingId, LOADING);
    this.enqueue(meetingId);
    this.emit();
  }

  /** The call changed (a push): ask again, but only for a call this page has drawn. */
  changed(meetingId: string): void {
    if (!this.entries.has(meetingId)) return;
    this.enqueue(meetingId);
  }

  /**
   * The socket came back: ask again for the cards that can still change (live, still loading, failed). An ended call and one the reader may not read are not
   * asked again, so a long channel does not spend the route's 120 a minute on a reconnect.
   */
  refreshAll(): void {
    for (const [id, e] of this.entries) if (e.status === 'loading' || e.status === 'failed' || (e.status === 'ok' && e.card.state === 'live')) this.enqueue(id);
  }

  /**
   * The end route answered that this call ended: the card turns into its event line now, even if asking for the fresh card fails. The next answer replaces it
   * with the server's numbers.
   */
  markEnded(meetingId: string): void {
    const e = this.entries.get(meetingId);
    if (e?.status !== 'ok' || e.card.state !== 'live') return;
    const now = this.deps.now();
    const endedAt = new Date(now).toISOString();
    const durationSeconds = Math.max(0, Math.floor((now - Date.parse(e.card.startedAt)) / 1000));
    this.entries.set(meetingId, {
      status: 'ok',
      card: { ...e.card, state: 'ended', endedAt, durationSeconds, present: [], presentCount: 0, you: { joined: false, canEnd: false, canInvite: false } },
    });
    this.emit();
  }

  /** Everything is forgotten (sign-out, another person in this tab): answers still on their way are dropped. */
  reset(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.queue = new Set();
    this.entries.clear();
    this.askedIn.clear();
    for (const list of this.waiters.values()) for (const resolve of list) resolve();
    this.waiters.clear();
    this.emit();
  }

  /** Ask again for one call and resolve once an answer that started after this call has come in (or failed). */
  refresh(meetingId: string): Promise<void> {
    if (!this.entries.has(meetingId)) this.entries.set(meetingId, LOADING);
    const done = new Promise<void>((resolve) => {
      const list = this.waiters.get(meetingId) ?? [];
      list.push(resolve);
      this.waiters.set(meetingId, list);
    });
    this.enqueue(meetingId);
    return done;
  }

  private enqueue(meetingId: string): void {
    this.queue.add(meetingId);
    if (this.timer === null) this.timer = this.deps.setTimeout(() => this.flush(), CARD_BATCH_MS);
  }

  private flush(): void {
    this.timer = null;
    const ids = [...this.queue];
    this.queue = new Set();
    for (let i = 0; i < ids.length; i += CALL_CARDS_MAX) void this.ask(ids.slice(i, i + CALL_CARDS_MAX));
  }

  private async ask(ids: string[]): Promise<void> {
    const n = ++this.batch;
    for (const id of ids) this.askedIn.set(id, n);
    // the waiters registered so far are answered by this request
    const waiting = ids.map((id) => {
      const w = this.waiters.get(id) ?? [];
      this.waiters.delete(id);
      return w;
    });
    let cards: CallCard[] | null = null;
    try {
      cards = (await this.deps.fetchCards(ids)).cards;
    } catch {
      cards = null;
    }
    const byId = new Map<string, CallCard>((cards ?? []).map((c) => [c.meetingId, c]));
    let changed = false;
    for (const id of ids) {
      if (this.askedIn.get(id) !== n) continue;
      const before = this.entries.get(id);
      const card = byId.get(id);
      if (cards === null) {
        // a failed ask keeps a card already drawn; a row still waiting shows its one-line start
        if (before?.status !== 'ok') {
          const tries = before?.status === 'failed' ? before.tries + 1 : 1;
          this.entries.set(id, { status: 'failed', tries, retryAt: this.deps.now() + Math.min(CARD_RETRY_MAX_MS, CARD_RETRY_MS * 2 ** (tries - 1)) });
          changed = true;
        }
      } else {
        this.entries.set(id, card ? { status: 'ok', card } : { status: 'gone' });
        changed = true;
      }
    }
    if (changed) this.emit();
    for (const w of waiting) for (const resolve of w) resolve();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

export const fetchCallCards = (ids: readonly string[]) => call(listCallCardsRoute, { response: ListCallCardsResponse }, { ids: ids.join(',') });

let store: CallCardsStore | null = null;
// the cards belong to whoever is signed in: another person in this tab starts clean
onPersonChange(() => store?.reset());

export function callCards(): CallCardsStore {
  store ??= new CallCardsStore({
    fetchCards: fetchCallCards,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as number),
    now: () => Date.now(),
  });
  return store;
}

/** The card of this call (asked for when the row is drawn); undefined in the mock mode, which has no server, and for no call (null). */
export function useCallCard(meetingId: string | null): CardEntry | undefined {
  const s = callCards();
  const mock = isMockMode();
  useEffect(() => {
    if (!mock && meetingId !== null) s.want(meetingId);
  }, [s, meetingId, mock]);
  const read = (): CardEntry | undefined => (meetingId === null ? undefined : s.get(meetingId));
  return useSyncExternalStore(s.subscribe, read, read);
}
