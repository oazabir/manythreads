import { z } from 'zod';

/*
 * The words a person can type in the search box besides the text to look for (PLAN P14-11):
 *
 *   from:nadia   from:"Nadia Hamdan"   from:me      who wrote the message (or uploaded the file, or last saved the page)
 *   in:dev       in:#dev                            the channel it sits in
 *   has:file     has:link                           a message with an attachment, or with a web address
 *   is:thread                                       a message that belongs to a thread
 *   before:2026-10-01   after:2026-10-01            a day, written year-month-day, read as UTC
 *
 * `has:pin` is not here: pins do not exist yet (PLAN P9-09), so the word stays plain text until they do.
 * The same function reads the text on the server (which decides what to search) and in the browser (which draws the chips), so
 * the two never disagree. It is linear: one pass over the characters, no backtracking pattern.
 */

export const SEARCH_HAS = ['file', 'link'] as const;
export const SearchHas = z.enum(SEARCH_HAS);
export type SearchHas = z.infer<typeof SearchHas>;

export const SEARCH_IS = ['thread'] as const;
export const SearchIs = z.enum(SEARCH_IS);
export type SearchIs = z.infer<typeof SearchIs>;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What the box holds once the filter words are taken out. `text` is what is left, words in their typed order. */
export const SearchFilters = z.object({
  text: z.string(),
  from: z.array(z.string()),
  in: z.array(z.string()),
  has: z.array(SearchHas),
  is: z.array(SearchIs),
  before: Day.nullable(),
  after: Day.nullable(),
});
export type SearchFilters = z.infer<typeof SearchFilters>;

/** At most this many names after `from:` or `in:`; further ones stay in the text. */
export const MAX_SEARCH_NAMES = 5;

const WORDS = ['from', 'in', 'has', 'is', 'before', 'after'] as const;
type Word = (typeof WORDS)[number];

/**
 * `2026-02-30` is not a day: the date must survive a round trip. The database has no year 0000, and the end of 9999-12-31 is the year 10000,
 * which it writes differently, so days run from 0001-01-01 to 9998-12-31 (anything else stays plain text, never an error).
 */
export function isSearchDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (s < '0001-01-01' || s > '9998-12-31') return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(s);
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Splits `raw` into tokens; a token is a run without spaces, or `word:"a quoted value"` (the quotes may hold spaces). */
function tokens(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && isSpace(raw[i]!)) i++;
    if (i >= n) break;
    const start = i;
    while (i < n) {
      const c = raw[i]!;
      if (c === '"' && raw[i - 1] === ':') {
        // a quote right after a colon opens a quoted value, up to the closing quote (or the end of the text)
        const close = raw.indexOf('"', i + 1);
        i = close === -1 ? n : close + 1;
        continue;
      }
      if (isSpace(c)) break;
      i++;
    }
    out.push(raw.slice(start, i));
  }
  return out;
}

const operatorOf = (token: string): { word: Word; value: string } | null => {
  const colon = token.indexOf(':');
  if (colon < 2 || colon > 6) return null;
  const word = token.slice(0, colon).toLowerCase();
  if (!(WORDS as readonly string[]).includes(word)) return null;
  let value = token.slice(colon + 1);
  if (value.startsWith('"')) value = value.endsWith('"') && value.length > 1 ? value.slice(1, -1) : value.slice(1);
  return { word: word as Word, value: value.trim() };
};

/** Reads the filter words out of what was typed. Anything that is not a valid filter stays in `text`, untouched. */
export function parseSearchText(raw: string): SearchFilters {
  const out: SearchFilters = { text: '', from: [], in: [], has: [], is: [], before: null, after: null };
  const rest: string[] = [];
  for (const token of tokens(raw)) {
    const op = operatorOf(token);
    let taken = false;
    if (op && op.value !== '') {
      const v = op.value;
      switch (op.word) {
        case 'from': {
          const name = v.replace(/^@/, '').trim();
          if (name !== '' && out.from.length < MAX_SEARCH_NAMES) {
            if (!out.from.some((x) => x.toLowerCase() === name.toLowerCase())) out.from.push(name);
            taken = true;
          }
          break;
        }
        case 'in': {
          const name = v.replace(/^#/, '').trim();
          if (name !== '' && out.in.length < MAX_SEARCH_NAMES) {
            if (!out.in.some((x) => x.toLowerCase() === name.toLowerCase())) out.in.push(name);
            taken = true;
          }
          break;
        }
        case 'has': {
          const w = v.toLowerCase();
          if (w === 'file' || w === 'link') {
            if (!out.has.includes(w)) out.has.push(w);
            taken = true;
          }
          break;
        }
        case 'is': {
          if (v.toLowerCase() === 'thread') {
            if (!out.is.includes('thread')) out.is.push('thread');
            taken = true;
          }
          break;
        }
        case 'before':
        case 'after': {
          if (isSearchDay(v)) {
            out[op.word] = v;
            taken = true;
          }
          break;
        }
      }
    }
    if (!taken) rest.push(token);
  }
  out.text = rest.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}

const quoteIfNeeded = (v: string): string => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/** Writes the filters back as the text a person would type (the inverse of {@link parseSearchText}, for chips). */
export function formatSearchText(f: SearchFilters): string {
  const parts: string[] = [];
  for (const v of f.from) parts.push(`from:${quoteIfNeeded(v)}`);
  for (const v of f.in) parts.push(`in:${quoteIfNeeded(v)}`);
  for (const v of f.has) parts.push(`has:${v}`);
  for (const v of f.is) parts.push(`is:${v}`);
  if (f.before) parts.push(`before:${f.before}`);
  if (f.after) parts.push(`after:${f.after}`);
  if (f.text !== '') parts.push(f.text);
  return parts.join(' ');
}

/** True when at least one filter word is in use. */
export const hasSearchFilters = (f: SearchFilters): boolean =>
  f.from.length + f.in.length + f.has.length + f.is.length > 0 || f.before !== null || f.after !== null;

/** `2026-10-01` read as UTC midnight at the start of that day. */
export const searchDayStart = (day: string): string => `${day}T00:00:00.000Z`;

/** The first instant after that day (for `after:`, which means "after the whole day"). */
export function searchDayEnd(day: string): string {
  return new Date(Date.parse(searchDayStart(day)) + 86_400_000).toISOString();
}
