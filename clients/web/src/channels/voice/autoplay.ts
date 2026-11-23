import { createContext, useContext, useSyncExternalStore } from 'react';
import { clipPlaying, onClipEnded, toggleClip } from './usePlayback';

/*
 * Autoplay of incoming voice messages (owner 2026-11-23): with the switch on, a voice message that arrives from someone else in an open thread or an open
 * direct-message conversation plays by itself. Several that arrive together play one after another; the reader's own messages, messages this reader has
 * already played and older messages drawn with the history are never played. The switch is kept on this device; its box sits in the header of a thread
 * and of a direct-message conversation. A browser that blocks sound until the page was touched plays nothing until then (the press on the switch counts).
 */

const KEY = 'manythreads.voice-autoplay';
/** A message drawn this long after it was written counts as arriving now; anything older is history. */
export const INCOMING_MS = 20_000;

const listeners = new Set<() => void>();
let enabled = ((): boolean => {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'on';
  } catch {
    return false;
  }
})();

export function autoplayOn(): boolean {
  return enabled;
}

export function setAutoplay(on: boolean): void {
  enabled = on;
  try {
    globalThis.localStorage?.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // a blocked storage keeps the switch until the page closes
  }
  if (!on) dismissAutoplay();
  for (const l of listeners) l();
}

export function useAutoplay(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled,
    () => false,
  );
  return [on, setAutoplay];
}

/** Set by a view whose incoming voice messages may play by themselves: an open thread, an open direct-message conversation. */
export const AutoplayZone = createContext(false);
export const useAutoplayZone = (): boolean => useContext(AutoplayZone);

type Clip = { messageId: string; fileId: string; durationMs: number; who: string };
const queue: Clip[] = [];
const asked = new Set<string>();

/** The autoplayed message playing (or paused) now, for the small player in the corner; null when none. */
let current: (Clip & { waiting: number }) | null = null;
const currentListeners = new Set<() => void>();
function setCurrent(c: Clip | null): void {
  current = c ? { ...c, waiting: queue.length } : null;
  for (const l of currentListeners) l();
}

export function useAutoplayCurrent(): (Clip & { waiting: number }) | null {
  return useSyncExternalStore(
    (l) => {
      currentListeners.add(l);
      return () => currentListeners.delete(l);
    },
    () => current,
    () => null,
  );
}

/** Closes the corner player: what plays stops at the end of this clip, and nothing waiting is played. */
export function dismissAutoplay(): void {
  queue.length = 0;
  setCurrent(null);
}

function playNext(): void {
  if (!enabled || clipPlaying()) return;
  const next = queue.shift();
  if (!next) return;
  setCurrent(next);
  toggleClip(next.fileId, next.durationMs, 0);
}

onClipEnded(() => {
  // the corner player goes with the last clip; the next one starts a moment later, so two messages do not run into each other
  if (queue.length === 0) setCurrent(null);
  setTimeout(playNext, 400);
});

/** Whether a message drawn now should play by itself. */
export function shouldAutoplay(o: { on: boolean; zone: boolean; own: boolean; played: boolean; createdAt: string; now?: number }): boolean {
  if (!o.on || !o.zone || o.own || o.played) return false;
  const age = (o.now ?? Date.now()) - Date.parse(o.createdAt);
  return Number.isFinite(age) && age >= -5_000 && age <= INCOMING_MS;
}

/** Puts an arriving voice message in line to play (once per message for the page's life). */
export function autoplayIncoming(clip: Clip): void {
  if (asked.has(clip.messageId)) return;
  asked.add(clip.messageId);
  queue.push(clip);
  if (current) setCurrent(current);
  playNext();
}
