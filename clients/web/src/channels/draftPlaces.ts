import { useSyncExternalStore } from 'react';

/*
 * Where each draft was written (owner, 2026-11-23): every message box (a channel, a thread, a direct message, a meeting, a chat with a bot) keeps its draft in
 * this browser under its own key, and this index remembers the page each key belongs to and a label for it, so the Drafts page can list them and take the
 * person back to the box with the text in it. Kept in this browser only.
 */

const INDEX_KEY = 'manythreads.draft-places';
const CHANGED = 'mt:drafts-changed';

export type DraftPlace = { key: string; path: string; label: string; preview: string; at: number };

/** The page and label of each box on screen now, set when the box opens, so a save (which may come after the page changed) knows where it belongs. */
const places = new Map<string, { path: string; label: string }>();

function readIndex(): Record<string, DraftPlace> {
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DraftPlace>) : {};
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, DraftPlace>): void {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    /* storage can be blocked: the list then shows nothing new */
  }
  cache = null;
  window.dispatchEvent(new Event(CHANGED));
}

/** A message box opened: remember its page and label for its key. */
export function placeDraft(key: string, path: string, label: string): void {
  places.set(key, { path, label });
}

/** A box's text was saved (empty: the draft is gone, sent or cleared). */
export function noteDraft(key: string, text: string): void {
  const index = readIndex();
  if (text.trim() === '') {
    if (!(key in index)) return;
    delete index[key];
    writeIndex(index);
    return;
  }
  const place = places.get(key) ?? index[key];
  if (!place) return;
  index[key] = { key, path: place.path, label: place.label, preview: text.replace(/\s+/g, ' ').trim().slice(0, 160), at: Date.now() };
  // at most 200 drafts are listed: the oldest go first
  const entries = Object.values(index).sort((a, b) => b.at - a.at);
  writeIndex(Object.fromEntries(entries.slice(0, 200).map((e) => [e.key, e])));
}

let cache: DraftPlace[] | null = null;
const snapshot = (): DraftPlace[] => (cache ??= Object.values(readIndex()).sort((a, b) => b.at - a.at));
const subscribe = (listener: () => void): (() => void) => {
  const on = (): void => {
    cache = null;
    listener();
  };
  window.addEventListener(CHANGED, on);
  window.addEventListener('storage', on);
  return () => {
    window.removeEventListener(CHANGED, on);
    window.removeEventListener('storage', on);
  };
};

/** Every draft with its place, newest first. */
export const useDraftPlaces = (): DraftPlace[] => useSyncExternalStore(subscribe, snapshot, () => []);
