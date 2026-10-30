import type { MyPresence, PresenceCard, UpdateDndRequest, UpdateMyPresenceRequest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { isMockMode } from '../api/setup';
import { fetchMyPresence, fetchPresenceCards, saveDnd, saveMyPresence, sendHeartbeat } from '../api/endpoints';
import { onPersonChange } from '../app/caches';

/*
 * Presence and status (docs/plugins/presence.md): the heartbeat that says "active" or "away", and the cards of the people the person may
 * see (status, time zone, hours, out of office). Both are polled every 30 seconds with the same tick -- nothing is pushed, so a change of
 * someone else's status shows within half a minute. The person's own settings (including Do not disturb, which only they can read) are kept
 * as the server last answered. The routes belong to the presence plugin, so a server without it answers 404 and the app shows no presence.
 */

/** Where reading the person's own settings stands: not asked yet, being asked, answered, no presence plugin (or no presence for this actor), or failed. */
export type MeStatus = 'idle' | 'loading' | 'ready' | 'absent' | 'error';

export type PresenceSnapshot = {
  /** The server has the presence plugin (known after the first answer). */
  supported: boolean;
  cards: ReadonlyMap<string, PresenceCard>;
  me: MyPresence | null;
  meStatus: MeStatus;
};

const INITIAL: PresenceSnapshot = { supported: false, cards: new Map(), me: null, meStatus: 'idle' };
/** How often the heartbeat and the cards are refreshed. The server calls a person offline after 90 seconds without one. */
export const PRESENCE_TICK_MS = 30_000;

export class PresenceStore {
  private snap: PresenceSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private absent = false;
  /** Counts the person's own writes, so an older read that arrives after a save cannot put the old settings back. */
  private writes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): PresenceSnapshot => this.snap;
  private set(next: Partial<PresenceSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }

  reset(): void {
    this.stop();
    this.absent = false;
    this.snap = INITIAL;
    for (const l of [...this.listeners]) l();
  }

  /** One round: tell the server we are here, then read everyone's card and our own settings. `away` when nobody has touched the tab for a while. */
  async tick(state: 'online' | 'away'): Promise<void> {
    if (this.absent) return;
    try {
      await sendHeartbeat(state);
      const writes = this.writes;
      const [cards, me] = await Promise.all([fetchPresenceCards(), fetchMyPresence()]);
      const fresh = writes === this.writes;
      this.set({ supported: true, cards: new Map(cards.people.map((c) => [c.personId, c])), ...(fresh ? { me, meStatus: 'ready' as const } : {}) });
    } catch (e) {
      // 404: no presence plugin; 403: a bot or another actor with no presence. Either way, stop asking.
      if (isApiError(e) && (e.status === 404 || e.status === 403)) {
        this.absent = true;
        this.set({ meStatus: 'absent' });
      }
    }
  }

  /**
   * Read only the person's own settings (status, time zone, hours, Do not disturb), without the heartbeat or anyone's card. The shell does this on
   * load, every minute and when the tab is shown again, so a pause made on another device shows up. Mock mode has no server and no presence.
   */
  async loadMe(): Promise<void> {
    if (isMockMode()) {
      this.absent = true;
      if (this.snap.meStatus !== 'absent') this.set({ meStatus: 'absent' });
      return;
    }
    if (this.absent) return;
    const writes = this.writes;
    if (this.snap.me === null) this.set({ meStatus: 'loading' });
    try {
      const me = await fetchMyPresence();
      if (writes !== this.writes) return; // the person saved something while this was on its way: their answer is newer
      this.set({ supported: true, me, meStatus: 'ready' });
    } catch (e) {
      if (isApiError(e) && (e.status === 404 || e.status === 403)) {
        this.absent = true;
        this.set({ meStatus: 'absent' });
      } else if (this.snap.me === null) {
        this.set({ meStatus: 'error' });
      }
    }
  }

  /** Beat now and every 30 seconds until `stop`. `state` is read at each beat. */
  start(state: () => 'online' | 'away'): void {
    this.stop();
    void this.tick(state());
    this.timer = setInterval(() => void this.tick(state()), PRESENCE_TICK_MS);
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
