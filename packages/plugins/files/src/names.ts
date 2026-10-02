/**
 * A file name that is safe to store, show and put in a header: one path segment (no directory, no traversal), no control or bidi-override
 * characters, no characters Windows refuses, at most 255 UTF-8 bytes with the extension kept. Never empty.
 */
export const MAX_NAME_BYTES = 255;

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Cuts `name` to at most `max` bytes without splitting a character, keeping the extension (up to 16 bytes of it) when there is one. */
function clip(name: string, max: number): string {
  if (utf8Bytes(name) <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && utf8Bytes(name.slice(dot)) <= 16 ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, dot) : name;
  const room = max - utf8Bytes(ext);
  let out = '';
  for (const ch of stem) {
    if (utf8Bytes(out + ch) > room) break;
    out += ch;
  }
  return out + ext;
}

export function sanitizeFileName(raw: string | undefined | null): string {
  let name = (raw ?? '').normalize('NFC');
  // Only the last segment of whatever path the client sent ("C:\\Users\\x\\a.txt", "../../etc/passwd" -> "a.txt", "passwd").
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    .replace(/[\t\n\r\f\v]/g, ' ')
    // control characters, line and paragraph separators, bidi overrides and isolates, zero-width and BOM characters
    .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/gu, '')
    // characters Windows and most shells choke on
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // no leading or trailing dots: ".." and hidden-file tricks, "name." that Windows strips
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  name = clip(name, MAX_NAME_BYTES);
  return name === '' ? 'file' : name;
}

/** `report.pdf` -> `report (2).pdf`; the number goes before the last extension and the result still fits 255 bytes. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && utf8Bytes(name.slice(dot)) <= 16;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  const suffix = ` (${n})`;
  return clip(stem, MAX_NAME_BYTES - utf8Bytes(ext) - utf8Bytes(suffix)) + suffix + ext;
}

/** The header carries the name percent-encoded UTF-8 (HTTP headers are Latin-1); a malformed escape falls back to the raw text. */
export function decodeHeaderName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** ASCII-only fallback for `filename="..."` in Content-Disposition. */
export const asciiFallback = (name: string): string => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
