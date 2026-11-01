import type { MyPresence, PresenceCard, UpdateDndRequest, UpdateMyPresenceRequest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { isMockMode } from '../api/setup';
import { fetchMyPresence, fetchPresenceCards, saveDnd, saveMyPresence, sendHeartbeat } from '../api/endpoints';
import { onPersonChange } from '../app/caches';

/*
 * Presence and status (docs/plugins/presence.md): the heartbeat that says "active" or "away", and the cards of the people the person may
 * see (status, time zone, hours, out of office). Both are polled every 30 seconds with the same tick -- nothing is pushed, so a change of
 * someone else's status shows within half a minute. The person's own settings (including Do not disturb, which only they can read) are kept
 * as the server last answered. The routes belong to the presence plugin, so a server without it answers 404 and the app shows no presence (and asks
 * again after a few minutes). Nothing is drawn from the cards until they have arrived (`cardsLoaded`) and while the last few rounds failed.
 */

/** Where reading the person's own settings stands: not asked yet, being asked, answered, no presence plugin (or no presence for this actor), or failed. */
export type MeStatus = 'idle' | 'loading' | 'ready' | 'absent' | 'error';

export type PresenceSnapshot = {
  /** The server has the presence plugin (known after the first answer). */
  supported: boolean;
  /** The cards of the people the reader may see have arrived at least once. Until then an absent card means "not known", not "offline". */
  cardsLoaded: boolean;
  /** Rounds in a row whose cards could not be fetched. The old cards stay, but are no longer shown as live after `STALE_AFTER_FAILS`. */
  failedTicks: number;
  cards: ReadonlyMap<string, PresenceCard>;
  me: MyPresence | null;
  meStatus: MeStatus;
};

const INITIAL: PresenceSnapshot = { supported: false, cardsLoaded: false, failedTicks: 0, cards: new Map(), me: null, meStatus: 'idle' };
/** How often the heartbeat and the cards are refreshed. The server calls a person offline after 90 seconds without one. */
export const PRESENCE_TICK_MS = 30_000;
/** After this many failed rounds in a row the cards on screen are old: dots and profile cards are no longer drawn from them. */
export const STALE_AFTER_FAILS = 3;
/** A server that answered 404 for the presence routes is asked again after this long (a plugin enabled meanwhile, or a restart in between). */
export const ABSENT_RETRY_MS = 5 * 60_000;

/** Whether the cards in a snapshot may be drawn as the current state of people. */
export const cardsAreLive = (snap: Pick<PresenceSnapshot, 'cardsLoaded' | 'failedTicks'>): boolean => snap.cardsLoaded && snap.failedTicks < STALE_AFTER_FAILS;

/** Everything on a card that is drawn, without `seenAt` (it moves on every beat of an active person and nothing shows it). */
function sameCard(a: PresenceCard, b: PresenceCard): boolean {
  return (
    a.presence === b.presence &&
    a.timeZone === b.timeZone &&
    JSON.stringify(a.status) === JSON.stringify(b.status) &&
    JSON.stringify(a.workingHours) === JSON.stringify(b.workingHours) &&
    JSON.stringify(a.outOfOffice) === JSON.stringify(b.outOfOffice)
  );
}

/**
 * The map of cards for a fresh answer. A card whose drawn parts did not change keeps the object it had (even though its `seenAt` moved), so a dot beside
 * a name -- which reads its own card -- does not draw again every 30 seconds for people whose state is the same: only the dots of people who changed.
 */
export function keepCards(before: ReadonlyMap<string, PresenceCard>, fresh: readonly PresenceCard[]): Map<string, PresenceCard> {
  const next = new Map<string, PresenceCard>();
  for (const card of fresh) {
    const old = before.get(card.personId);
    next.set(card.personId, old && sameCard(old, card) ? old : card);
  }
  return next;
}

const is404 = (e: unknown): boolean => isApiError(e) && e.status === 404;

export class PresenceStore {
  private snap: PresenceSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** Until when the server is taken to have no presence plugin (a 404); 0 = it has. */
  private absentUntil = 0;
  /** Counts the person's own writes, so an older read that arrives after a save cannot put the old settings back. */
  private writes = 0;
  /** Bumped by `reset` (another person signed in): an answer that was on its way for the earlier person is dropped. */
  private generation = 0;
  /** The number of the latest full round; a round whose answer comes back after a newer one started is dropped. */
  private round = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The screens that hold the heartbeat loop open (see `acquire`). */
  private readonly holders = new Set<symbol>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): PresenceSnapshot => this.snap;
  private set(next: Partial<PresenceSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }
  private isAbsent(): boolean {
    return Date.now() < this.absentUntil;
  }
  private markAbsent(forever = false): void {
    this.absentUntil = forever ? Number.POSITIVE_INFINITY : Date.now() + ABSENT_RETRY_MS;
    this.set({ supported: false, meStatus: 'absent' });
  }

  reset(): void {
    this.stop();
    this.absentUntil = 0;
    this.generation += 1;
    this.round += 1;
    this.snap = INITIAL;
    for (const l of [...this.listeners]) l();
  }

  /**
   * One round: tell the server we are here (`state` null: this tab does not beat, because another tab of the browser is in use), then -- unless
   * `beatOnly`, which is a hidden tab -- read everyone's card and our own settings. Only the newest round's answer is applied, and none after `reset`.
   */
  async tick(state: 'online' | 'away' | null, beatOnly = false): Promise<void> {
    if (this.isAbsent()) return;
    const generation = this.generation;
    const round = beatOnly ? this.round : ++this.round;
    try {
      if (state !== null) await sendHeartbeat(state);
      if (beatOnly) return;
      const writes = this.writes;
      const [cards, me] = await Promise.all([fetchPresenceCards(), fetchMyPresence()]);
      if (generation !== this.generation || round !== this.round) return;
      const fresh = writes === this.writes;
      this.absentUntil = 0;
      this.set({
        supported: true,
        cardsLoaded: true,
        failedTicks: 0,
        cards: keepCards(this.snap.cards, cards.people),
        ...(fresh ? { me, meStatus: 'ready' as const } : {}),
      });
    } catch (e) {
      if (generation !== this.generation) return;
      // 404: the server has no presence plugin; ask again in a few minutes. Anything else (a 403, a 500, a dropped connection) is a failed round:
      // the old cards stay for now, and stop being drawn as live after a few in a row.
      if (is404(e)) this.markAbsent();
      else if (!beatOnly && round === this.round) this.set({ failedTicks: this.snap.failedTicks + 1 });
    }
  }

  /**
   * Read only the person's own settings (status, time zone, hours, Do not disturb), without the heartbeat or anyone's card. The shell does this once on
   * load, and the round of `tick` keeps it fresh after that, so a pause made on another device shows up. Mock mode has no server and no presence.
   */
  async loadMe(): Promise<void> {
    if (isMockMode()) {
      this.absentUntil = Number.POSITIVE_INFINITY;
      if (this.snap.meStatus !== 'absent') this.set({ meStatus: 'absent' });
      return;
    }
    if (this.isAbsent()) return;
    const writes = this.writes;
    const generation = this.generation;
    if (this.snap.me === null) this.set({ meStatus: 'loading' });
    try {
      const me = await fetchMyPresence();
      if (generation !== this.generation) return; // another person signed in meanwhile
      if (writes !== this.writes) return; // the person saved something while this was on its way: their answer is newer
      this.set({ supported: true, me, meStatus: 'ready' });
    } catch (e) {
      if (generation !== this.generation) return;
      if (is404(e)) this.markAbsent();
      else if (this.snap.me === null) this.set({ meStatus: 'error' });
    }
  }

  /**
   * Beat now and every 30 seconds until every holder has let go. `state` is read at each beat (null: this tab does not beat); `hidden` says the tab is
   * hidden, so only the beat is sent. Several screens may hold it at once (the shell, the settings pages, the account page, one after the other or
   * overlapping while the router swaps them): the loop is started once, by the first holder, and stopped when the last one releases. Returns the release.
   */
  acquire(state: () => 'online' | 'away' | null, hidden: () => boolean = () => false): () => void {
    const token = Symbol('presence holder');
    this.holders.add(token);
    if (this.timer === null) {
      void this.tick(state(), hidden());
      this.timer = setInterval(() => void this.tick(state(), hidden()), PRESENCE_TICK_MS);
    }
    return () => {
      this.holders.delete(token);
      if (this.holders.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Save some of the public parts (status, time zone, hours, out of office); the answer is the whole of the person's settings. */
  async saveProfile(body: UpdateMyPresenceRequest): Promise<MyPresence> {
    return this.accept(await saveMyPresence(body));
  }

  /** Save Do not disturb (on or off, a pause, the weekly schedule). */
  async saveDnd(body: UpdateDndRequest): Promise<MyPresence> {
    return this.accept(await saveDnd(body));
  }

  /** Put the answer in the store at once, and fold the person's own card to match, so their name changes before the next tick. */
  private accept(me: MyPresence): MyPresence {
    this.writes += 1;
    const own = [...this.snap.cards.values()].find((c) => c.personId === this.ownId);
    if (own) {
      const cards = new Map(this.snap.cards);
      cards.set(own.personId, { ...own, status: me.status, timeZone: me.timeZone, workingHours: me.workingHours, outOfOffice: me.outOfOffice });
      this.set({ me, cards, meStatus: 'ready' });
    } else {
      this.set({ me, meStatus: 'ready' });
    }
    return me;
  }

  /** The signed-in person's id, set by the shell so their own card can be updated in place. */
  ownId: string | null = null;
}

export const presenceStore = new PresenceStore();
onPersonChange(() => presenceStore.reset());
