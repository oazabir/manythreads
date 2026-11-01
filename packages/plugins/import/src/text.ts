import { IMPORT_MESSAGE_MAX_CHARS } from '@manythreads/shared';

// Reading text out of an archive without trusting it: which encoding it is in, where one JSON value ends and the next begins, how deep it nests, and
// what a message's text becomes. Nothing here evaluates anything: JSON.parse of a bounded slice, and string work.

/** The string with every lone surrogate replaced by U+FFFD (what `String.prototype.toWellFormed` does, which this build's library settings do not know). */
export const wellFormed = (s: string): string => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');

export class NotTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotTextError';
  }
}

/**
 * The text of a file: UTF-8 (with or without a byte order mark) or UTF-16 with a byte order mark. Anything else (Latin-1, a binary file) is refused
 * rather than guessed at, because a guess turns names into the wrong names.
 */
export function decodeText(buf: Uint8Array): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    throw new NotTextError('The file is not UTF-8 text');
  }
}

export type JsonPiece = { ok: true; value: unknown } | { ok: false; reason: 'malformed' | 'too_deep' };

/**
 * Splits the text of a JSON array into its top-level elements and parses each on its own, so one broken or hostile element costs that element and
 * nothing around it. The scan is one pass over the characters (linear in the text, never recursive); it tracks strings and escapes so brackets inside
 * text do not count, and refuses an element that nests deeper than `maxDepth` before it is parsed. Throws `NotTextError` if the text is not an array.
 */
export function* splitJsonArray(text: string, maxDepth: number): Generator<JsonPiece> {
  let i = 0;
  const n = text.length;
  const skipSpace = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xfeff) i += 1;
      else break;
    }
  };
  skipSpace();
  if (text.charCodeAt(i) !== 0x5b) throw new NotTextError('The file is not a JSON array');
  i += 1;
  for (;;) {
    skipSpace();
    if (i >= n) throw new NotTextError('The JSON array is not closed');
    const c = text.charCodeAt(i);
    if (c === 0x5d) return;
    if (c === 0x2c) {
      i += 1;
      continue;
    }
    const start = i;
    let depth = 0;
    let deep = false;
    let inString = false;
    for (; i < n; i += 1) {
      const ch = text.charCodeAt(i);
      if (inString) {
        if (ch === 0x5c) i += 1;
        else if (ch === 0x22) inString = false;
        continue;
      }
      if (ch === 0x22) inString = true;
      else if (ch === 0x7b || ch === 0x5b) {
        depth += 1;
        if (depth > maxDepth) deep = true;
      } else if (ch === 0x7d || ch === 0x5d) {
        if (depth === 0) break; // the array's own closing bracket
        depth -= 1;
      } else if (ch === 0x2c && depth === 0) break;
    }
    if (i >= n && depth !== 0) throw new NotTextError('The JSON array is cut short');
    const piece = text.slice(start, i);
    if (deep) {
      yield { ok: false, reason: 'too_deep' };
      continue;
    }
    try {
      yield { ok: true, value: JSON.parse(piece) as unknown };
    } catch {
      yield { ok: false, reason: 'malformed' };
    }
  }
}

/** The depth of one JSON text, scanned without recursion. */
export function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1;
      else if (ch === 0x22) inString = false;
    } else if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === 0x7d || ch === 0x5d) depth -= 1;
  }
  return max;
}

export type Line = { line: Buffer } | { tooLong: true };

/**
 * Cuts a byte stream into lines. A line longer than `maxLineBytes` is not kept: its bytes are thrown away as they arrive (so a stream with no line break
 * at all costs no memory) and one `{ tooLong: true }` stands in for it. Blank lines are skipped. A carriage return before the line break is dropped.
 */
export async function* splitLines(source: AsyncIterable<Uint8Array>, maxLineBytes: number): AsyncGenerator<Line> {
  let parts: Buffer[] = [];
  let held = 0;
  let discarding = false;
  for await (const chunk of source) {
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (buf.length > 0) {
      const nl = buf.indexOf(0x0a);
      const piece = nl < 0 ? buf : buf.subarray(0, nl);
      if (!discarding) {
        held += piece.length;
        if (held > maxLineBytes) {
          discarding = true;
          parts = [];
          held = 0;
        } else if (piece.length > 0) parts.push(piece);
      }
      if (nl < 0) break;
      if (discarding) yield { tooLong: true };
      else if (held > 0) {
        let line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, held);
        if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        if (line.length > 0) yield { line: Buffer.from(line) };
      }
      parts = [];
      held = 0;
      discarding = false;
      buf = buf.subarray(nl + 1);
    }
  }
  if (discarding) yield { tooLong: true };
  else if (held > 0) {
    const line = Buffer.concat(parts, held);
    if (line.length > 0) yield { line };
  }
}

/**
 * The text of a message made safe to store: no NUL or other control characters (a line break and a tab stay), no lone surrogates, at most the platform's
 * message length. `shortened` says the text was cut. An empty result means there was nothing to keep.
 */
export function cleanMessageText(raw: string): { text: string; shortened: boolean } {
  // eslint-disable-next-line no-control-regex
  let text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
  text = wellFormed(text);
  let shortened = false;
  if (text.length > IMPORT_MESSAGE_MAX_CHARS) {
    text = wellFormed(text.slice(0, IMPORT_MESSAGE_MAX_CHARS));
    shortened = true;
  }
  return { text: text.trim(), shortened };
}

/** A name or label made safe to show and store: one line, no control characters, shortened. */
export function cleanLabel(raw: unknown, max = 200): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return wellFormed(wellFormed(raw.replace(/[\u0000-\u001f\u007f]+/g, ' ')).trim().slice(0, max));
}

/** An email address as the platform keeps one: lowercase, and null for anything that is not plausibly an address. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length >= 3 && e.length <= 320 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(e) ? e : null;
}

/** A name as a mention handle: `Ada Lovelace` becomes `ada-lovelace`. The import writes mentions as plain text, so this is only how the name reads. */
export function handleOf(name: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug === '' ? 'someone' : slug;
}
