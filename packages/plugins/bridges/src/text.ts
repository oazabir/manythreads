import { BRIDGE_MAX_TEXT } from '@manythreads/shared';

// Everything a chat service sends is hostile text (PLAN Bundle D, section 10). This file is the one place it is cleaned before it is stored, posted or compared, and the one place the text that
// leaves is shaped. Pure functions, no I/O, linear in the input.

/**
 * What is taken out of text from a chat app: controls other than the newline and the tab, soft hyphens, the invisible direction marks and joiners, the line and paragraph separators and
 * the byte order mark. The ranges are numbers (not escapes in a pattern) so the file holds no invisible character itself.
 */
const UNWANTED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];
const hex = (n: number): string => n.toString(16).padStart(4, '0');
const UNWANTED = new RegExp(`[${UNWANTED_RANGES.map(([a, b]) => `\\u${hex(a)}-\\u${hex(b)}`).join('')}]`, 'g');
const LONE_SURROGATE = new RegExp('[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]', 'g');
/** `@channel`, `@here` and `@everyone` wake a whole room; text from a chat app never does that. */
const BROADCAST = /@(channel|here|everyone)\b/gi;
/** The word joiner (U+2060) placed after the @ of a broadcast word: it keeps the word apart from the @, so no mention of a whole room is made. */
const WORD_JOINER = String.fromCharCode(0x2060);

/** Cuts to `max` characters (code points), adding an ellipsis when it cut. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * Cleans what a person typed in a chat app before it is posted: control and direction characters out, carriage returns to newlines, a broadcast mention made plain text, no more than
 * `BRIDGE_MAX_TEXT` characters, nothing at the ends. The result may be empty (a message of only invisible characters), and then nothing is posted.
 */
export function cleanInbound(text: string, max: number = BRIDGE_MAX_TEXT): string {
  const unified = text.normalize('NFC').replace(/\r\n?/g, '\n');
  const clean = unified.replace(LONE_SURROGATE, '').replace(UNWANTED, '').replace(BROADCAST, `@${WORD_JOINER}$1`);
  return cut(clean.replace(/\n{4,}/g, '\n\n\n').trim(), max);
}

/** A label from a chat service (a display name) shown on a page or put in a sentence: one short plain line. */
export function cleanLabel(text: string, max = 120): string {
  return cut(
    text
      .normalize('NFC')
      .replace(LONE_SURROGATE, '')
      .replace(UNWANTED, '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim(),
    max,
  );
}

/** "Name: text" as it is sent to a chat app, cut to the limit. The name is cleaned the same way; markup is not added (the services get plain text). */
export function outboundLine(name: string, text: string, max: number = BRIDGE_MAX_TEXT): string {
  const who = cleanLabel(name, 80) || 'Someone';
  const body = text.replace(UNWANTED, '').replace(LONE_SURROGATE, '').replace(/\r\n?/g, '\n').trim();
  return cut(`${who}: ${body}`, max);
}

/** A code as people type it: eight digits, maybe with a space or a dash in the middle. Null when the text is not a code. */
export function asCode(text: string, digits = 8): string | null {
  const squeezed = text.trim().replace(/^code[:\s]+/i, '').replace(/[\s-]/g, '');
  return new RegExp(`^[0-9]{${digits}}$`).test(squeezed) ? squeezed : null;
}
