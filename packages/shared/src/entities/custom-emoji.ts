import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, CustomEmojiId } from '../ids.ts';

// Custom emoji (PLAN P14-02, plugin `channels`): pictures a workspace admin adds, written `:name:` in a message or a reaction and drawn as the picture.
// Shared so the browser (which draws them) and the server (which stores them) agree on the name rule, the limits and the one check of what a picture is.

/** The kinds of picture that are kept. Never SVG or HTML: a picture the server hands out must not be able to carry script. */
export const CUSTOM_EMOJI_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const CustomEmojiType = z.enum(CUSTOM_EMOJI_TYPES);
export type CustomEmojiType = z.infer<typeof CustomEmojiType>;

/** The biggest picture, in bytes (it is drawn at about 22 pixels, so this is generous). */
export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;
/** The most custom emoji one workspace holds. */
export const CUSTOM_EMOJI_MAX_PER_WORKSPACE = 500;

/**
 * A name: 2 to 32 characters, lower-case letters, digits and underscores, starting with a letter (so a clock time such as 10:30:15 never reads as an emoji).
 * `:partyparrot:` is written with colons around the name; the colons are not part of it.
 */
export const CUSTOM_EMOJI_NAME_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
export const CustomEmojiName = z.string().regex(CUSTOM_EMOJI_NAME_PATTERN, 'a name has 2 to 32 lower-case letters, digits or underscores, and starts with a letter');
export type CustomEmojiName = z.infer<typeof CustomEmojiName>;

/** `:name:` for a name. */
export const emojiToken = (name: string): string => `:${name}:`;

/** The name inside a reaction written `:name:`, or null when the text is not shaped like one. */
export function customEmojiNameOf(emoji: string): string | null {
  if (emoji.length < 4 || emoji[0] !== ':' || emoji[emoji.length - 1] !== ':') return null;
  const name = emoji.slice(1, -1);
  return CUSTOM_EMOJI_NAME_PATTERN.test(name) ? name : null;
}

export const CustomEmoji = z.object({
  id: CustomEmojiId,
  name: CustomEmojiName,
  contentType: CustomEmojiType,
  size: z.number().int().positive().max(CUSTOM_EMOJI_MAX_BYTES),
  /** The admin who added it; null once that person is gone. */
  createdBy: ActorId.nullable(),
  createdAt: IsoDateTime,
});
export type CustomEmoji = z.infer<typeof CustomEmoji>;

const startsWith = (bytes: Uint8Array, at: number, sig: readonly number[]): boolean => sig.every((b, i) => bytes[at + i] === b);

/** What the bytes really are, by their first bytes (the name a client sends is not trusted): one of the four kinds above, or null. */
export function sniffEmojiImage(bytes: Uint8Array): CustomEmojiType | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/** The longest side of a picture, in pixels (it is drawn at about 22, so this is generous), and the most frames an animated one may have. */
export const CUSTOM_EMOJI_MAX_SIDE = 512;
export const CUSTOM_EMOJI_MAX_FRAMES = 100;

/** What the header of a picture says about its size: width and height in pixels (null when the header cannot be read) and, for an animation, how many frames. */
export interface EmojiImageInfo {
  type: CustomEmojiType;
  width: number | null;
  height: number | null;
  /** 1 for a still picture; for GIF, APNG and animated WebP the frames counted (counting stops one past `CUSTOM_EMOJI_MAX_FRAMES`). */
  frames: number;
}

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number): number => (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0;
const u32le = (b: Uint8Array, at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
const tag = (b: Uint8Array, at: number): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

function pngInfo(b: Uint8Array): EmojiImageInfo {
  const none: EmojiImageInfo = { type: 'image/png', width: null, height: null, frames: 1 };
  if (b.length < 24 || tag(b, 12) !== 'IHDR') return none;
  let frames = 1;
  // an animated PNG says how many frames it has in an `acTL` chunk before its first `IDAT`
  for (let p = 8; p + 8 <= b.length; ) {
    const length = u32be(b, p);
    const kind = tag(b, p + 4);
    if (kind === 'acTL') frames = Math.max(1, u32be(b, p + 8));
    if (kind === 'IDAT' || kind === 'IEND') break;
    p += 12 + length;
  }
  return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20), frames };
}

function jpegInfo(b: Uint8Array): EmojiImageInfo {
  const none: EmojiImageInfo = { type: 'image/jpeg', width: null, height: null, frames: 1 };
  for (let p = 2; p + 4 <= b.length; ) {
    if (b[p] !== 0xff) {
      p += 1;
      continue;
    }
    const marker = b[p + 1] ?? 0;
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return none; // the picture data starts before any frame header was seen
    // a start-of-frame header (not the huffman table, the arithmetic table or the reserved ones) holds the size
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return p + 9 <= b.length ? { type: 'image/jpeg', height: u16be(b, p + 5), width: u16be(b, p + 7), frames: 1 } : none;
    }
    p += 2 + u16be(b, p + 2);
  }
  return none;
}

function gifInfo(b: Uint8Array): EmojiImageInfo {
  if (b.length < 13) return { type: 'image/gif', width: null, height: null, frames: 1 };
  const skipSubBlocks = (from: number): number => {
    let p = from;
    while (p < b.length) {
      const n = b[p] ?? 0;
      p += 1 + n;
      if (n === 0) break;
    }
    return p;
  };
  let p = 13;
  const screen = b[10] ?? 0;
  if (screen & 0x80) p += 3 * 2 ** ((screen & 7) + 1);
  let frames = 0;
  while (p < b.length && frames <= CUSTOM_EMOJI_MAX_FRAMES) {
    const block = b[p];
    if (block === 0x2c) {
      frames += 1;
      if (p + 10 > b.length) break;
      const local = b[p + 9] ?? 0;
      p += 10;
      if (local & 0x80) p += 3 * 2 ** ((local & 7) + 1);
      p = skipSubBlocks(p + 1);
    } else if (block === 0x21) {
      p = skipSubBlocks(p + 2);
    } else {
      break; // the trailer (0x3b), or bytes that are not a GIF block
    }
  }
  return { type: 'image/gif', width: u16le(b, 6), height: u16le(b, 8), frames: Math.max(1, frames) };
}

function webpInfo(b: Uint8Array): EmojiImageInfo {
  const info: EmojiImageInfo = { type: 'image/webp', width: null, height: null, frames: 1 };
  let frames = 0;
  for (let p = 12; p + 8 <= b.length && frames <= CUSTOM_EMOJI_MAX_FRAMES; ) {
    const kind = tag(b, p);
    const size = u32le(b, p + 4);
    const data = p + 8;
    if (kind === 'VP8X' && data + 10 <= b.length) {
      info.width = u24le(b, data + 4) + 1;
      info.height = u24le(b, data + 7) + 1;
    } else if (kind === 'VP8 ' && info.width === null && data + 10 <= b.length && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
      info.width = u16le(b, data + 6) & 0x3fff;
      info.height = u16le(b, data + 8) & 0x3fff;
    } else if (kind === 'VP8L' && info.width === null && data + 5 <= b.length && b[data] === 0x2f) {
      const bits = u32le(b, data + 1);
      info.width = (bits & 0x3fff) + 1;
      info.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'ANMF') {
      frames += 1;
    }
    p = data + size + (size % 2);
  }
  info.frames = Math.max(1, frames);
  return info;
}

/**
 * What the header of a picture says about its size and frame count, for the checks that keep a "small" emoji small. Null when the bytes are not one of the four
 * kinds. A header that cannot be read gives `width` and `height` null, which the caller treats as a refusal. The bytes are not decoded.
 */
export function emojiImageInfo(bytes: Uint8Array): EmojiImageInfo | null {
  switch (sniffEmojiImage(bytes)) {
    case 'image/png':
      return pngInfo(bytes);
    case 'image/jpeg':
      return jpegInfo(bytes);
    case 'image/gif':
      return gifInfo(bytes);
    case 'image/webp':
      return webpInfo(bytes);
    default:
      return null;
  }
}

/** A plain sentence for a picture that is too large in pixels, has too many frames, or whose size cannot be read; null when it is fine. */
export function emojiImageProblem(info: EmojiImageInfo): string | null {
  if (info.width === null || info.height === null || info.width < 1 || info.height < 1) return 'the size of that picture could not be read; use a normal PNG, JPEG, GIF or WebP file';
  if (info.width > CUSTOM_EMOJI_MAX_SIDE || info.height > CUSTOM_EMOJI_MAX_SIDE) {
    return `the picture is ${info.width} by ${info.height} pixels; the most allowed is ${CUSTOM_EMOJI_MAX_SIDE} by ${CUSTOM_EMOJI_MAX_SIDE}`;
  }
  if (info.frames > CUSTOM_EMOJI_MAX_FRAMES) return `the animation has more than ${CUSTOM_EMOJI_MAX_FRAMES} frames, which is the most allowed`;
  return null;
}
