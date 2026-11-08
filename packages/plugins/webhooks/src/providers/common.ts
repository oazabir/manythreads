import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// The small pure helpers every work app's reader shares: constant-time comparison, a signature of the raw body, a timestamp window, and the cuts that keep outside text short and
// on one line. Nothing here runs a regular expression with a quantifier over a body: the body is read as bytes, signed as bytes and parsed once with JSON.parse, which is linear.

/** How far a provider's own timestamp may be from our clock (five minutes, either way), and Linear's tighter one. */
export const WINDOW_MS = 5 * 60_000;
export const LINEAR_WINDOW_MS = 60_000;
/** How old an event's own time may be for the apps that send no timestamp with their signature (the dedupe window). */
export const EVENT_AGE_MS = 7 * 24 * 60 * 60_000;

export type Headers = Readonly<Record<string, string | undefined>>;

/** Constant-time equality of two strings of any length (both are hashed first so the lengths do not show). */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a, 'utf8').digest();
  const y = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(x, y);
}

export const hmacHex = (algorithm: 'sha256' | 'sha1', secret: string, data: string | Uint8Array): string => createHmac(algorithm, secret).update(data).digest('hex');
export const hmacBase64 = (secret: string, data: string | Uint8Array): string => createHmac('sha256', secret).update(data).digest('base64');

/** `prefix` followed by exactly `length` hexadecimal characters, or null: the shape check before anything is compared. */
export function hexAfter(value: string | undefined, prefix: string, length: number): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v.length !== prefix.length + length || !v.toLowerCase().startsWith(prefix)) return null;
  const hex = v.slice(prefix.length).toLowerCase();
  for (let i = 0; i < hex.length; i++) {
    const c = hex.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const letter = c >= 97 && c <= 102;
    if (!digit && !letter) return null;
  }
  return hex;
}

/** Whether two hex strings of the same length are equal, in constant time. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Whether `stamp` (milliseconds) is within `window` of `now`. Not a number, or not finite: no. */
export const withinWindow = (stamp: number, now: number, window: number): boolean => Number.isFinite(stamp) && Math.abs(now - stamp) <= window;

/** Collapses whitespace and control characters (newlines included) to single spaces, trims and cuts: a value that must stay on one line. Linear: one pass over the characters. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value);
  let out = '';
  let space = true;
  for (let i = 0; i < text.length && out.length < max + 1; i++) {
    const code = text.charCodeAt(i);
    // C0 and C1 controls, line and paragraph separators, bidirectional marks and isolates, zero-width characters
    const hidden = code < 32 || (code >= 127 && code < 160) || code === 0x2028 || code === 0x2029 || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
    if (hidden || code === 32) {
      if (!space) out += ' ';
      space = true;
      continue;
    }
    out += text[i];
    space = false;
  }
  return out.trim().slice(0, max);
}

/** A web address a person may be sent to: http or https only, cut at 2000 characters. Anything else is null. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Text with its markup tags removed (one pass, no regular expression), for the apps that send HTML in a message. */
export function stripTags(html: unknown): string {
  if (typeof html !== 'string') return '';
  let out = '';
  let inTag = false;
  for (let i = 0; i < html.length && out.length < 2000; i++) {
    const c = html[i];
    if (c === '<') inTag = true;
    else if (c === '>' && inTag) {
      inTag = false;
      out += ' ';
    } else if (!inTag) out += c;
  }
  return out;
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** `o.a.b` as an object chain, undefined when a link is missing or not an object. */
export function at(o: unknown, ...path: string[]): unknown {
  let cur: unknown = o;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A time in milliseconds from an ISO string, a number of ms, or (when `seconds`) a number of seconds; null when it is none of them. */
export function toMs(v: unknown, seconds = false): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return seconds ? v * 1000 : v;
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const KIND = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
/** Whether `kind` is a kind the platform accepts (`ticket.created`). */
export const isKind = (kind: string): boolean => kind.length <= 64 && KIND.test(kind);
/** A provider's own word made into a kind: lower case, anything else an underscore; null when it does not make one. */
export function kindFrom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw
    .toLowerCase()
    .slice(0, 80)
    .split('.')
    .map((p) => {
      let out = '';
      for (const c of p) out += (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ? c : '_';
      return out;
    });
  const kind = parts.join('.');
  return isKind(kind) ? kind : null;
}

/** sha256 of bytes, hex. */
export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The payload kept with an event: the same JSON cut down so that it is always well under the 64 KB the table allows. Depth, array length, key count and string length are
 * capped, and the caps tighten until the text fits. Keys that could touch an object's prototype are dropped. What is left is outside text and is only ever read as data.
 */
export function trimPayload(body: unknown, budgetBytes = 48_000): unknown {
  for (const [depth, items, keys, chars] of [
    [6, 20, 60, 2000],
    [5, 10, 40, 500],
    [4, 5, 30, 120],
    [3, 3, 20, 60],
  ] as const) {
    const cut = (v: unknown, d: number): unknown => {
      if (typeof v === 'string') return v.length > chars ? `${v.slice(0, chars)}…` : v;
      if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
      if (d >= depth) return undefined;
      if (Array.isArray(v)) return v.slice(0, items).map((x) => cut(x, d + 1));
      if (isObj(v)) {
        const out: Obj = {};
        let n = 0;
        for (const key of Object.keys(v)) {
          if (BLOCKED_KEYS.has(key)) continue;
          if (n++ >= keys) break;
          const value = cut(v[key], d + 1);
          if (value !== undefined) out[key.slice(0, 80)] = value;
        }
        return out;
      }
      return undefined;
    };
    const trimmed = cut(body, 0);
    if (Buffer.byteLength(JSON.stringify(trimmed ?? null)) <= budgetBytes) return trimmed ?? null;
  }
  return null;
}
