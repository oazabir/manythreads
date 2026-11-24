import { BookmarksChangedPush, WS_BOOKMARKS_CHANGED, bookmarkKey, type BookmarkTarget, type BookmarkTargetKind, type SavedBookmark } from '@manythreads/shared';
import { useSyncExternalStore } from 'react';
import { fetchBookmarkKeys, removeSavedBookmark, saveBookmark } from '../api/endpoints';
import { isApiError } from '../api/client';
import { isMockMode } from '../api/setup';
import { onPersonChange } from '../app/caches';
import { realtimeClient } from '../realtime';

/*
 * The client's copy of the person's bookmarks (P36-08, docs/plans/bookmarks.md): which threads and messages are bookmarked, as keys, and how many there
 * are. A thread pane, a message row and the sidebar ask it through narrow hooks (one answer each, so a change re-renders only who reads it); the Bookmarks
 * page reads its own list from the server and keeps this copy in step. It loads `/api/bookmarks/keys` once; a write changes the copy at once and puts it
 * back when the server refuses; while one write of a target is out, another press on it is ignored (`pending`). The `bookmarks.changed` push keeps the
 * other tabs in step, and a reconnect reads the keys again. A server without the bookmarks plugin answers 404: the store reports `supported: false` and
 * every control is left out. A person switch (`reset`) starts a new generation: a keys answer asked for by the person before is dropped.
 */

export type BookmarksSnapshot = {
  /** The server has the bookmarks plugin and the person may have bookmarks (false after a 404 or a 403). */
  supported: boolean;
  /** Fetched at least once. */
  loaded: boolean;
  /** `<kind>:<key>` to the bookmark's id (`''` while a new one is being saved). */
  ids: ReadonlyMap<string, string>;
  /** How many bookmarks the person has: the sidebar shows Bookmarks while it is above 0. */
  total: number;
  /** Bumped when a thread bookmark is confirmed by the server, or comes or goes in another tab: what the Threads view's Bookmarked list is keyed on. */
  threadVersion: number;
  /** Slots with a write still out. */
  pending: ReadonlySet<string>;
};

const INITIAL: BookmarksSnapshot = { supported: true, loaded: false, ids: new Map(), total: 0, threadVersion: 0, pending: new Set() };

/** The one spelling of a target among the person's bookmarks: `<kind>:<key>`. */
export const slotOf = (kind: BookmarkTargetKind, key: string): string => `${kind}:${key}`;
export const slotOfTarget = (t: BookmarkTarget): string => slotOf(t.kind, bookmarkKey(t));

/** What a refused or failed write says: the server's own sentence when it gave one. */
export function bookmarkErrorText(e: unknown): string {
  if (isApiError(e) && e.status !== 0 && e.status < 500 && e.message) return e.message;
  return 'Could not change the bookmark. Try again.';
}

/** What a toggle did: `on` is the state now; `ignored` when another write of the same target was still out (nothing was sent). */
export type ToggleResult = { on: boolean; ignored: boolean };

export class BookmarksStore {
  private snap: BookmarksSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private wired = false;
  /** The person's generation: `reset` moves it on, and an answer for an older one is dropped. */
  private generation = 0;
  private readonly changeHooks = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): BookmarksSnapshot => this.snap;
  private set(next: Partial<BookmarksSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }
  private put(slot: string, id: string | null, extra: Partial<BookmarksSnapshot> = {}): void {
    const ids = new Map(this.snap.ids);
    if (id === null) ids.delete(slot);
    else ids.set(slot, id);
    this.set({ ids, total: ids.size, ...extra });
  }
  private setPending(slot: string, on: boolean): void {
    const pending = new Set(this.snap.pending);
    if (on) pending.add(slot);
    else pending.delete(slot);
    this.set({ pending });
  }
  private bumpThreads(kind: BookmarkTargetKind): Partial<BookmarksSnapshot> {
    return kind === 'thread' ? { threadVersion: this.snap.threadVersion + 1 } : {};
  }

  reset(): void {
    this.generation += 1;
    this.inflight = null;
    this.snap = INITIAL;
    for (const l of [...this.listeners]) l();
  }

  has(kind: BookmarkTargetKind, key: string): boolean {
    return this.snap.ids.has(slotOf(kind, key));
  }
  isPending(kind: BookmarkTargetKind, key: string): boolean {
    return this.snap.pending.has(slotOf(kind, key));
  }

  /** Listens to the tab's socket once: a push from another tab changes the copy, a reconnect reads it again. */
  private wire(): void {
    if (this.wired || isMockMode()) return;
    this.wired = true;
    const rt = realtimeClient();
    rt.onPush((push) => {
      if (push.type !== WS_BOOKMARKS_CHANGED) return;
      const p = BookmarksChangedPush.safeParse(push.payload);
      if (!p.success) return;
      const slot = slotOf(p.data.kind, p.data.key);
      // this tab's own write comes back too: a push that changes nothing (or lands on a write still out) is not news
      if (this.snap.pending.has(slot)) return;
      const had = this.snap.ids.get(slot);
      if (p.data.on ? had === p.data.id : had === undefined) return;
      this.put(slot, p.data.on ? p.data.id : null, this.bumpThreads(p.data.kind));
      for (const h of [...this.changeHooks]) h();
    });
    rt.onReconnected(() => void this.load(true));
  }

  /** Called after a change from another tab (the Bookmarks page reads its list again). */
  onChange(hook: () => void): () => void {
    this.changeHooks.add(hook);
    return () => {
      this.changeHooks.delete(hook);
    };
  }

  /** Loads the keys once (and again with `force`); concurrent calls share one request; an answer for a person switched away from is dropped. */
  load(force = false): Promise<void> {
    this.wire();
    if (!this.snap.supported || (this.snap.loaded && !force)) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const run = fetchBookmarkKeys().then(
      (res) => {
        if (generation !== this.generation) return;
        const ids = new Map(res.items.map((i) => [slotOf(i.kind, i.key), i.id] as const));
        const threadsChanged = this.snap.loaded && [...ids.keys(), ...this.snap.ids.keys()].some((s) => s.startsWith('thread:') && ids.get(s) !== this.snap.ids.get(s));
        this.set({ loaded: true, ids, total: ids.size, ...(threadsChanged ? { threadVersion: this.snap.threadVersion + 1 } : {}) });
      },
      (e: unknown) => {
        if (generation !== this.generation) return;
        if (isApiError(e) && (e.status === 404 || e.status === 403)) this.set({ supported: false, loaded: true, ids: new Map(), total: 0 });
      },
    );
    const shared = run.finally(() => {
      if (this.inflight === shared) this.inflight = null;
    });
    this.inflight = shared;
    return shared;
  }

  /**
   * Adds or removes the bookmark of a target. The copy changes at once and is put back when the server refuses; then this rejects with the server's
   * error. A press while a write of the same target is still out is ignored (`ignored: true`, nothing sent): the controls are disabled meanwhile.
   */
  async toggle(target: BookmarkTarget): Promise<ToggleResult> {
    const slot = slotOfTarget(target);
    const generation = this.generation;
    const id = this.snap.ids.get(slot);
    if (this.snap.pending.has(slot)) return { on: id !== undefined, ignored: true };
    this.setPending(slot, true);
    try {
      if (id !== undefined) {
        this.put(slot, null);
        try {
          await removeSavedBookmark(id);
        } catch (e) {
          // already gone on the server (another tab): it stays off
          if (!(isApiError(e) && e.status === 404)) {
            if (generation === this.generation) this.put(slot, id);
            throw e;
          }
        }
        if (generation === this.generation) this.set(this.bumpThreads(target.kind));
        return { on: false, ignored: false };
      }
      this.put(slot, '');
      try {
        const saved = await saveBookmark(target);
        if (generation === this.generation) this.put(slot, saved.id, this.bumpThreads(target.kind));
        return { on: true, ignored: false };
      } catch (e) {
        if (generation === this.generation) this.put(slot, null);
        throw e;
      }
    } finally {
      if (generation === this.generation) this.setPending(slot, false);
    }
  }

  /** Removes a bookmark by its id (the Bookmarks page), keeping the copy in step. */
  async remove(id: string): Promise<void> {
    const slot = [...this.snap.ids.entries()].find(([, v]) => v === id)?.[0];
    if (slot) this.put(slot, null);
    try {
      await removeSavedBookmark(id);
    } catch (e) {
      if (isApiError(e) && e.status === 404) return;
      if (slot) this.put(slot, id);
      throw e;
    }
    if (slot?.startsWith('thread:')) this.set({ threadVersion: this.snap.threadVersion + 1 });
  }

  /** Bookmarks a target again (Undo on the Bookmarks page); resolves to the new bookmark as the server holds it. */
  async restore(target: BookmarkTarget): Promise<SavedBookmark> {
    const saved = await saveBookmark(target);
    this.put(slotOfTarget(target), saved.id, this.bumpThreads(target.kind));
    return saved;
  }
}

export const bookmarksStore = new BookmarksStore();
onPersonChange(() => bookmarksStore.reset());

/** The whole snapshot: for the few places that read several answers at once (the Bookmarks page). Most should use a narrow hook below. */
export const useBookmarks = (): BookmarksSnapshot => useSyncExternalStore(bookmarksStore.subscribe, bookmarksStore.snapshot);

/** The controls are drawn only once the keys are in and the server has bookmarks. */
export const useBookmarksReady = (): boolean => useSyncExternalStore(bookmarksStore.subscribe, () => bookmarksStore.snapshot().supported && bookmarksStore.snapshot().loaded);
/** The server has bookmarks (true until it answered otherwise). */
export const useBookmarksSupported = (): boolean => useSyncExternalStore(bookmarksStore.subscribe, () => bookmarksStore.snapshot().supported);
export const useBookmarkTotal = (): number => useSyncExternalStore(bookmarksStore.subscribe, () => bookmarksStore.snapshot().total);
export const useThreadBookmarkVersion = (): number => useSyncExternalStore(bookmarksStore.subscribe, () => bookmarksStore.snapshot().threadVersion);

/** Whether one target is bookmarked; a row re-renders only when its own answer changes. */
export function useBookmarked(kind: BookmarkTargetKind, key: string): boolean {
  return useSyncExternalStore(bookmarksStore.subscribe, () => bookmarksStore.has(kind, key));
}
/** Whether a write of one target is still out (its control is disabled meanwhile). */
export function useBookmarkPending(kind: BookmarkTargetKind, key: string): boolean {
  return useSyncExternalStore(bookmarksStore.subscribe, () => bookmarksStore.isPending(kind, key));
}
