export const MARKER_OPEN: Readonly<Record<string, string>> = { '[': ']', '［': '］', '【': '】' };
export const NO_NUMBERS: ReadonlySet<number> = new Set();

export const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
/** White space of every kind that reaches a reader as a gap: the ASCII ones, NBSP, the Unicode spaces, and the zero-width characters. */
export const isWs = (ch: string | undefined): boolean => {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200d) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x2060 || c === 0x3000 || c === 0xfeff
  );
};

/**
 * A marker group at `i`: `[n]`, `[a, b]`, `[a-b]`, `[ n ]`, `［n］`, `【n】` (numbers of one to three digits, at most 40 characters in all).
 * `hit` says whether any number of it (any number of a range) is in `removed`.
 */
export function markerAt(text: string, i: number, removed: ReadonlySet<number>): { end: number; hit: boolean } | null {
  const close = MARKER_OPEN[text[i]!];
  if (close === undefined) return null;
  const limit = Math.min(text.length, i + 40);
  let j = i + 1;
  let hit = false;
  for (;;) {
    while (j < limit && isWs(text[j])) j += 1;
    let a = 0;
    let digits = 0;
    while (digits < 3 && j < limit && isDigit(text[j])) {
      a = a * 10 + (text.charCodeAt(j) - 48);
      j += 1;
      digits += 1;
    }
    if (digits === 0) return null;
    let b = a;
    while (j < limit && isWs(text[j])) j += 1;
    const dash = text[j];
    if (dash === '-' || dash === '–' || dash === '—' || dash === '~') {
      j += 1;
      while (j < limit && isWs(text[j])) j += 1;
      b = 0;
      digits = 0;
      while (digits < 3 && j < limit && isDigit(text[j])) {
        b = b * 10 + (text.charCodeAt(j) - 48);
        j += 1;
        digits += 1;
      }
      if (digits === 0) return null;
      while (j < limit && isWs(text[j])) j += 1;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (const r of removed) {
      if (r >= lo && r <= hi) {
        hit = true;
        break;
      }
    }
    // the client reads `\]` as a plain `]` before it looks for markers, so `[2\]` and `\[2\]` are markers there: a backslash may precede the bracket
    if (text[j] === '\\' && text[j + 1] === close) j += 1;
    const c = text[j];
    if (c === close) return { end: j + 1, hit };
    if (j >= limit || (c !== ',' && c !== '，' && c !== '、' && c !== ';')) return null;
    j += 1;
  }
}

/** Does `text` hold a marker group of a removed citation? */
export function holdsMarker(text: string, removed: ReadonlySet<number>): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (MARKER_OPEN[text[i]!] === undefined) continue;
    if (markerAt(text, i, removed)?.hit === true) return true;
  }
  return false;
}
