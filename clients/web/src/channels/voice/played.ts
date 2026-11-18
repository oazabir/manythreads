/*
 * Which voice messages this reader has played (P32-06): the mic badge on the sender's picture is green until the reader plays the message, grey after.
 * The ids live in this browser's `localStorage` only (nothing goes to the server), under the signed-in person's id: the newest 500 are kept. Every storage call is wrapped: a private
 * window or blocked site data makes the badge forget, never fail.
 */

const KEY = 'mt.voice.played';
/** The storage key of one person: two people who share a browser do not share what they played. */
export const playedKey = (owner: string | null): string => `${KEY}.${owner ?? 'anonymous'}`;
export const KEEP_PLAYED = 500;

/** The ids in the stored text, oldest first; anything that is not a list of strings is dropped. */
export function parsePlayed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The list after `id` was played: it moves to the end, and only the newest `KEEP_PLAYED` stay. */
export function withPlayed(ids: readonly string[], id: string, keep: number = KEEP_PLAYED): string[] {
  const next = ids.filter((x) => x !== id);
  next.push(id);
  return next.length > keep ? next.slice(next.length - keep) : next;
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let cache: Set<string> | null = null;
let owner: string | null = null;
const listeners = new Set<() => void>();

function load(s: Storage | null = store()): Set<string> {
  if (cache) return cache;
  let ids: string[] = [];
  try {
    ids = parsePlayed(s?.getItem(playedKey(owner)) ?? null);
  } catch {
    ids = [];
  }
  cache = new Set(ids);
  return cache;
}

/** Has this reader played the message? */
export const isPlayed = (id: string): boolean => load().has(id);

/** The reader played the message: remembered (in this browser only) and every badge of it turns grey. Never throws. */
export function markPlayed(id: string, s: Storage | null = store()): void {
  if (load(s).has(id)) return;
  const next = withPlayed([...load(s)], id);
  cache = new Set(next);
  try {
    s?.setItem(playedKey(owner), JSON.stringify(next));
  } catch {
    /* storage is full or blocked: the badge forgets */
  }
  listeners.forEach((f) => f());
}

export function subscribePlayed(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Whose list this is (the signed-in person's actor id; null when nobody is): another person starts from their own list. */
export function setPlayedOwner(next: string | null): void {
  if (next === owner) return;
  owner = next;
  cache = null;
  listeners.forEach((f) => f());
}

// another tab of this browser played a message: read the list again
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== playedKey(owner)) return;
    cache = null;
    listeners.forEach((f) => f());
  });
}

/** Forgets what was read (a new person signed in, and the tests). */
export function resetPlayed(): void {
  cache = null;
  listeners.forEach((f) => f());
}
