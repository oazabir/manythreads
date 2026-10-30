import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { dndState, liveStatus, type CustomStatus, type DndState, type MyPresence, type PresenceCard } from '@manythreads/shared';
import { isMockMode } from '../api/setup';
import { dndBanner, type DndBanner } from './settingsModel';
import { presenceStore, type MeStatus, type PresenceSnapshot } from './store';

export function usePresence(): PresenceSnapshot {
  return useSyncExternalStore(presenceStore.subscribe, presenceStore.snapshot);
}

/** The card of one person, or undefined when the server has none (nothing to show, or no presence plugin). */
export function usePresenceCard(personId: string | null | undefined): PresenceCard | undefined {
  const snap = usePresence();
  return personId ? snap.cards.get(personId) : undefined;
}

/** The current time, refreshed every `everyMs`, so "their time" and a status that clears do not stay stale. */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** No input for this long: the tab is `away`. */
export const IDLE_AFTER_MS = 5 * 60_000;

/**
 * Keep the heartbeat while the shell is on screen: `online` while the person is using the tab, `away` when the tab is hidden or nothing
 * has been touched for five minutes. Mock mode has no server, so no heartbeat.
 */
export function useHeartbeat(personId: string): void {
  useEffect(() => {
    if (isMockMode()) return;
    presenceStore.ownId = personId;
    let lastInput = Date.now();
    const touch = (): void => {
      lastInput = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const state = (): 'online' | 'away' => (document.visibilityState === 'hidden' || Date.now() - lastInput > IDLE_AFTER_MS ? 'away' : 'online');
    presenceStore.start(state);
    // coming back to the tab beats at once instead of waiting out the interval
    const wake = (): void => {
      if (document.visibilityState === 'visible') {
        touch();
        void presenceStore.tick('online');
      }
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      document.removeEventListener('visibilitychange', wake);
      presenceStore.stop();
    };
  }, [personId]);
}

/** How often the person's own settings are read again while the shell is open (a pause made on another device shows up within this time). */
export const MY_PRESENCE_REFRESH_MS = 60_000;

/**
 * Keep the person's own presence settings (status, time zone, Do not disturb) fresh while the shell is on screen: read at once, every minute and
 * when the tab is shown again. It sends no heartbeat and fetches nobody's card. Mock mode and a server without the plugin read nothing.
 */
export function useWatchMyPresence(personId: string): void {
  useEffect(() => {
    presenceStore.ownId = personId;
    void presenceStore.loadMe();
    const id = setInterval(() => void presenceStore.loadMe(), MY_PRESENCE_REFRESH_MS);
    const wake = (): void => {
      if (document.visibilityState === 'visible') void presenceStore.loadMe();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [personId]);
}

export type MyDnd = {
  /** The server has the presence plugin and has answered for this person. */
  supported: boolean;
  status: MeStatus;
  me: MyPresence | null;
  /** The person's custom status right now (null once its clear time has passed). */
  customStatus: CustomStatus | null;
  /** Whether Do not disturb is on right now, worked out in the browser from the saved settings so it ends on time without another request. */
  state: DndState | null;
  banner: DndBanner | null;
  now: Date;
};

/** The person's own Do not disturb state, kept exact: it re-renders at the moment a pause or a quiet period ends. */
export function useMyDnd(): MyDnd {
  const snap = usePresence();
  const [now, setNow] = useState(() => new Date());
  const me = snap.me;
  // a schedule that never stops (every hour of every day) makes dndState scan a whole week, so it is worked out once per clock tick, not once per render
  const settings = me?.dnd;
  const zone = me?.timeZone ?? null;
  const state = useMemo(() => (settings ? dndState(settings, zone, now) : null), [settings, zone, now]);
  const until = state?.active && state.until ? Date.parse(state.until) : null;
  const clears = me?.status?.clearsAt ? Date.parse(me.status.clearsAt) : null;
  useEffect(() => {
    if (!settings) return; // nothing to watch: no presence plugin, or not read yet
    // wake at the end of the pause or the status (and at least every 30 s, so a quiet period that starts by the clock shows too)
    const next = [until, clears].filter((t): t is number => t !== null && t > Date.now()).sort((a, b) => a - b)[0];
    const wait = Math.min(30_000, next !== undefined ? Math.max(250, next - Date.now() + 250) : 30_000);
    const id = setTimeout(() => setNow(new Date()), wait);
    return () => clearTimeout(id);
  }, [now, until, clears, settings]);
  return {
    supported: snap.supported && me !== null,
    status: snap.meStatus,
    me,
    customStatus: me ? liveStatus(me.status, now) : null,
    state,
    banner: dndBanner(state, now),
    now,
  };
}
