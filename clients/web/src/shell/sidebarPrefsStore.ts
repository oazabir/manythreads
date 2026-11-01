import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_SIDEBAR_PREFS, type SidebarPrefs } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchSidebarPrefs, saveSidebarPrefs } from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import { applyPatch, inversePatch, type PrefsPatch } from './sidebarLayout';

/*
 * The person's own sidebar view for each team (PLAN P14-15): starred channels, how the groups are sorted, whether quiet channels are folded
 * away, and the order of the groups. It is kept on the server, so it follows the person to another device. A change shows at once, is sent in
 * the order it was made, and is undone with one plain sentence if the server refuses it. Stars travel as "add these, remove those", so a tab
 * that is out of date cannot undo a star made somewhere else; the view is asked for again when the tab comes back and when the socket reconnects.
 */

export type PrefsEntry = {
  /**
   * `idle`: not asked yet. `loading`: the first answer is on its way. `error`: the first answer did not come; the next load or return to the tab
   * asks again. `unavailable`: this person has no such settings here (a guest, or a server without them): the defaults apply and nothing is offered.
   * In every state but `ok` the defaults apply and the sidebar still draws; the personal controls appear once the answer is in.
   */
  status: 'idle' | 'loading' | 'ok' | 'error' | 'unavailable';
  prefs: SidebarPrefs;
};

const IDLE: PrefsEntry = { status: 'idle', prefs: DEFAULT_SIDEBAR_PREFS };
const LOADING: PrefsEntry = { status: 'loading', prefs: DEFAULT_SIDEBAR_PREFS };
const FAILED: PrefsEntry = { status: 'error', prefs: DEFAULT_SIDEBAR_PREFS };
const UNAVAILABLE: PrefsEntry = { status: 'unavailable', prefs: DEFAULT_SIDEBAR_PREFS };
const SAVE_FAILED = 'Could not save your sidebar. Try again.';
const NOT_READY = 'Your sidebar settings are still loading. Try again in a moment.';
/** A tab that comes back asks again at most this often. */
export const REFRESH_EVERY_MS = 15_000;

export class SidebarPrefsStore {
  private entries = new Map<string, PrefsEntry>();
  private readonly listeners = new Set<() => void>();
  /** Bumped by `reset()` (another person signed in): work that started before it writes nothing. */
  private generation = 0;
  private inflight = new Map<string, { run: Promise<void>; rev: number }>();
  /** Per team: writes wait for the one before them, so the server sees the changes in the order they were made. */
  private chains = new Map<string, Promise<void>>();
  /** Per team: changes made and not yet answered. Never below 0. */
  private pending = new Map<string, number>();
  /** Per team: moves whenever a change starts or ends, so an answer to an older question can be told from a current one. */
  private revs = new Map<string, number>();
  private askedAt = new Map<string, number>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  entry = (slug: string | null): PrefsEntry => (slug ? (this.entries.get(slug) ?? IDLE) : IDLE);
  private set(slug: string, next: PrefsEntry): void {
    this.entries = new Map(this.entries).set(slug, next);
    for (const l of [...this.listeners]) l();
  }
  /** The map itself is the snapshot: it is replaced, never changed in place, so a subscriber sees a new value exactly when something moved. */
  snapshot = (): ReadonlyMap<string, PrefsEntry> => this.entries;
  private rev = (slug: string): number => this.revs.get(slug) ?? 0;
  private open = (slug: string): number => this.pending.get(slug) ?? 0;
  private bump(slug: string): void {
    this.revs.set(slug, this.rev(slug) + 1);
  }

  reset(): void {
    this.generation += 1;
    this.entries = new Map();
    this.inflight.clear();
    this.chains.clear();
    this.pending.clear();
    this.revs.clear();
    this.askedAt.clear();
    for (const l of [...this.listeners]) l();
  }

  /** Loads a team's view the first time (again with `force`, and again when the first try failed). */
  load(slug: string, force = false): Promise<void> {
    const have = this.entries.get(slug);
    const running = this.inflight.get(slug);
    // An answer to a question asked before the latest change is thrown away, so a forced load asks again instead of sharing it.
    if (running) return force && running.rev !== this.rev(slug) ? running.run.then(() => this.load(slug, true)) : running.run;
    if (!force && have && have.status !== 'idle' && have.status !== 'error') return Promise.resolve();
    if (!have || have.status === 'idle' || have.status === 'error') this.set(slug, LOADING);
    const generation = this.generation;
    const rev = this.rev(slug);
    this.askedAt.set(slug, Date.now());
    // The answer counts only if nothing changed since the question: no reset, no change started or ended, none waiting.
    const current = (): boolean => generation === this.generation && rev === this.rev(slug) && this.open(slug) === 0;
    const run: Promise<void> = fetchSidebarPrefs(slug)
      .then(
        (prefs) => {
          if (current()) this.set(slug, { status: 'ok', prefs });
        },
        (e: unknown) => {
          if (generation !== this.generation) return;
          const held = this.entries.get(slug);
          // A 403 or 404 means this person has no such settings here: show the defaults and offer nothing. Any other failure (a dropped
          // connection, a server error) is not a verdict: what is held stays, or, with nothing held, the next load asks again.
          if (isApiError(e) && (e.status === 403 || e.status === 404)) {
            if (current() || held?.status !== 'ok') this.set(slug, UNAVAILABLE);
          } else if (!held || held.status === 'loading') this.set(slug, FAILED);
        },
      )
      .finally(() => {
        if (this.inflight.get(slug)?.run === run) this.inflight.delete(slug);
      });
    this.inflight.set(slug, { run, rev });
    return run;
  }

  /** Asks again for every team held (the tab came back, the socket reconnected). Teams with a change on its way are left alone. */
  refreshAll(force = false): void {
    const now = Date.now();
    for (const [slug, entry] of this.entries) {
      if (entry.status === 'unavailable' || entry.status === 'loading' || entry.status === 'idle') continue;
      if (this.open(slug) > 0) continue;
      if (!force && now - (this.askedAt.get(slug) ?? 0) < REFRESH_EVERY_MS) continue;
      void this.load(slug, true);
    }
  }

  /**
   * Changes some fields at once and sends them. The screen shows the new value immediately; if the server refuses, the old value comes back and
   * the returned promise rejects with a sentence for the person.
   */
  update(slug: string, patch: PrefsPatch): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve();
    const before = this.entry(slug);
    if (before.status !== 'ok') {
      void this.load(slug);
      return Promise.reject(new Error(NOT_READY));
    }
    const generation = this.generation;
    const undo = inversePatch(before.prefs, patch);
    this.bump(slug);
    this.pending.set(slug, this.open(slug) + 1);
    this.set(slug, { status: 'ok', prefs: applyPatch(before.prefs, patch) });
    const settle = (): number => {
      this.pending.set(slug, Math.max(0, this.open(slug) - 1));
      this.bump(slug);
      return this.open(slug);
    };
    const job = (this.chains.get(slug) ?? Promise.resolve()).then(async () => {
      if (generation !== this.generation) return; // another person signed in meanwhile: this change is not theirs to send
      try {
        const saved = await saveSidebarPrefs(slug, patch);
        if (generation !== this.generation) return;
        // Take the server's answer only when nothing newer is waiting; it also drops stars on channels that are gone.
        if (settle() === 0) this.set(slug, { status: 'ok', prefs: saved });
      } catch (e) {
        if (generation !== this.generation) return;
        // With a newer change waiting, the screen keeps showing it (no flash back to the old value); the answer to the last change corrects
        // whatever this one left behind. Without one, this change is taken back and the server is asked what is true.
        if (settle() === 0) {
          this.set(slug, { status: 'ok', prefs: applyPatch(this.entry(slug).prefs, undo) });
          void this.load(slug, true);
        }
        throw new Error(isApiError(e) && e.status >= 400 && e.status < 500 && e.status !== 429 ? e.message : SAVE_FAILED);
      }
    });
    this.chains.set(
      slug,
      job.catch(() => undefined),
    );
    return job;
  }
}

export const sidebarPrefsStore = new SidebarPrefsStore();
onPersonChange(() => sidebarPrefsStore.reset());

/** One team's sidebar view, asked for the first time it is needed. */
export function useSidebarPrefs(slug: string | null, enabled = true): PrefsEntry {
  const all = useSyncExternalStore(sidebarPrefsStore.subscribe, sidebarPrefsStore.snapshot);
  useEffect(() => {
    if (slug && enabled) void sidebarPrefsStore.load(slug);
  }, [slug, enabled]);
  if (!slug || !enabled) return UNAVAILABLE;
  return all.get(slug) ?? IDLE;
}
