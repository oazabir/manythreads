import { useEffect, useSyncExternalStore } from 'react';
import { CUSTOM_EMOJI_MAX_BYTES, CUSTOM_EMOJI_TYPES, customEmojiNameOf, sniffEmojiImage, type CustomEmoji } from '@manythreads/shared';
import { fetchCustomEmoji } from '../api/endpoints';
import { onPersonChange } from '../app/caches';

/*
 * Custom emoji in the page (PLAN P14-02): the workspace's list, kept once for every message, reaction and picker that draws one. The list is small (500
 * at most), so it is read whole, again after a minute at most, and at once after an admin adds or removes one. Text is split by plain functions.
 */

export type CustomEmojiState = { items: readonly CustomEmoji[]; byName: ReadonlyMap<string, CustomEmoji>; loaded: boolean };

const EMPTY: CustomEmojiState = { items: [], byName: new Map(), loaded: false };
const TTL_MS = 60_000;

let state: CustomEmojiState = EMPTY;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of [...listeners]) l();
};

/** Reads the list (not again within a minute unless `force`). A failed read keeps what is held: a picture that cannot be drawn shows its `:name:` text. */
export function loadCustomEmoji(force = false, now = Date.now()): Promise<void> {
  if (inflight) return inflight;
  if (!force && state.loaded && now - loadedAt < TTL_MS) return Promise.resolve();
  inflight = fetchCustomEmoji()
    .then((r) => {
      state = { items: r.items, byName: new Map(r.items.map((e) => [e.name, e])), loaded: true };
      loadedAt = Date.now();
      emit();
    })
    .catch(() => {
      // keep the old list; try again after the next minute
      loadedAt = Date.now();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Forget what was held (a sign-out, a test). */
export function resetCustomEmoji(): void {
  state = EMPTY;
  loadedAt = 0;
  inflight = null;
  emit();
}
onPersonChange(resetCustomEmoji);

/** What an admin's add or removal just did, without waiting for the next read. */
export function customEmojiChanged(): void {
  void loadCustomEmoji(true);
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The workspace's custom emoji, read on first use. The page draws again when the list changes. */
export function useCustomEmoji(): CustomEmojiState {
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    void loadCustomEmoji();
  }, []);
  return current;
}

/** The list as it is now, without subscribing (for drawing code that is called while a component renders and re-renders from `useCustomEmoji`). */
export const currentCustomEmoji = (): CustomEmojiState => state;

export type EmojiPiece = string | CustomEmoji;

const NAME_AT = /:([a-z][a-z0-9_]{1,31}):/g;
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_:]/u.test(c);

/**
 * Splits text at the `:name:` tokens that name a known custom emoji. A token counts only on its own: a letter, digit, underscore or colon right before or
 * after it (a time like 10:30:15, `a:b:c`) leaves it as text. Text that holds none comes back as a single piece, unchanged.
 */
export function splitCustomEmoji(text: string, byName: ReadonlyMap<string, CustomEmoji>): EmojiPiece[] {
  if (byName.size === 0 || !text.includes(':')) return [text];
  const out: EmojiPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(NAME_AT)) {
    const at = m.index ?? 0;
    const hit = byName.get(m[1] ?? '');
    if (!hit || isWordChar(text[at - 1]) || isWordChar(text[at + m[0].length])) continue;
    if (at > last) out.push(text.slice(last, at));
    out.push(hit);
    last = at + m[0].length;
  }
  if (out.length === 0) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A name for a picture chosen from a file: its file name without the extension, in the letters a name allows ("Party Parrot.gif" -> "party_parrot"). */
export function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '').toLowerCase();
  let name = base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (name !== '' && !/^[a-z]/.test(name)) name = `e_${name}`;
  return name.slice(0, 32).replace(/_+$/, '');
}

/** Why a chosen picture cannot be added, in a sentence, or null when it can. The server checks again by the picture's own bytes. */
export function pictureProblem(file: { type: string; size: number }): string | null {
  if (!(CUSTOM_EMOJI_TYPES as readonly string[]).includes(file.type)) return 'Choose a PNG, JPEG, GIF or WebP picture.';
  if (file.size > CUSTOM_EMOJI_MAX_BYTES) return `The picture is too big. It can be at most ${CUSTOM_EMOJI_MAX_BYTES / 1024} KB.`;
  return null;
}

/** The sentence for a name that is not allowed, or null. */
export function nameProblem(name: string): string | null {
  if (name === '') return 'Give the emoji a name.';
  if (customEmojiNameOf(`:${name}:`) === null) return 'A name has 2 to 32 lower-case letters, digits or underscores, and starts with a letter.';
  return null;
}

/** The picture's bytes as base64 (what the add route takes). */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** True when the bytes are a picture kind the server keeps (a quick local check before the upload; the server decides). */
export const looksLikePicture = (bytes: Uint8Array): boolean => sniffEmojiImage(bytes) !== null;
