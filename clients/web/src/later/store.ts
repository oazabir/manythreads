import type { LaterItem } from '@manythreads/shared';
import { fetchLater, removeLater, saveLater, setLaterState } from '../api/endpoints';
import { isApiError } from '../api/client';
import { onPersonChange } from '../app/caches';

/*
 * The client's copy of the person's open Later items (PLAN P14-04, docs/plugins/reminders.md). A message row asks "is this one saved?" and the
 * Later list reads the same copy, so a save made from a message shows in the list at once and the other way round. The server is the truth: every
 * write answers with the item as the server holds it, and the list is fetched again when it is opened. A server without the reminders plugin
 * answers 404 on the first fetch; the store then reports `supported: false` and the menus leave the actions out.
 */

export type LaterSnapshot = {
  /** The server has the reminders plugin (true until a fetch is answered with 404). */
  supported: boolean;
  /** Fetched at least once. */
  loaded: boolean;
  /** Open items, due ones first. */
  items: readonly LaterItem[];
  dueCount: number;
  openCount: number;
};

const INITIAL: LaterSnapshot = { supported: true, loaded: false, items: [], dueCount: 0, openCount: 0 };

const byDue = (a: LaterItem, b: LaterItem): number => Number(b.due) - Number(a.due) || (a.due && b.due ? (a.remindAt ?? '').localeCompare(b.remindAt ?? '') : 0);

export class LaterStore {
  private snap: LaterSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): LaterSnapshot => this.snap;
  private set(next: Partial<LaterSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }

  reset(): void {
    this.inflight = null;
    this.snap = INITIAL;
    for (const l of [...this.listeners]) l();
  }

  /** The open item for a message, if the person saved it. */
  itemFor(messageId: string): LaterItem | undefined {
    return this.snap.items.find((i) => i.messageId === messageId);
  }

  /** Loads the open items once (and again on demand with `force`); concurrent calls share one request. */
  load(force = false): Promise<void> {
    if (!this.snap.supported || (this.snap.loaded && !force)) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const run = fetchLater('open').then(
      (res) => this.set({ loaded: true, items: res.items, dueCount: res.dueCount, openCount: res.openCount }),
      (e: unknown) => {
        if (isApiError(e) && (e.status === 404 || e.status === 403)) this.set({ supported: false, loaded: true });
      },
    );
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private put(item: LaterItem): void {
    const rest = this.snap.items.filter((i) => i.id !== item.id);
    const items = item.state === 'open' ? [...rest, item].sort(byDue) : rest;
    this.set({ items, openCount: items.length, dueCount: items.filter((i) => i.due).length });
  }

  /** Saves a message, with a reminder time or without; resolves to the item. Rejects with the server's sentence in `message` when refused. */
  async save(messageId: string, remindAt?: string | null): Promise<LaterItem> {
    const item = await saveLater(messageId, remindAt);
    this.put(item);
    return item;
  }

  async setState(itemId: string, state: 'open' | 'done'): Promise<LaterItem> {
    const item = await setLaterState(itemId, state);
    this.put(item);
    return item;
  }

  async remove(itemId: string): Promise<void> {
    await removeLater(itemId);
    const items = this.snap.items.filter((i) => i.id !== itemId);
    this.set({ items, openCount: items.length, dueCount: items.filter((i) => i.due).length });
  }
}

export const laterStore = new LaterStore();
onPersonChange(() => laterStore.reset());
