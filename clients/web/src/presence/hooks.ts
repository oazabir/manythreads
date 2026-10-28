import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PresenceCard } from '@manythreads/shared';
import { isMockMode } from '../api/setup';
import { presenceStore, type PresenceSnapshot } from './store';

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
