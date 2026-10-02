/*
 * Which words of a result to mark. The server matches by trigram word similarity ("rolback" finds "rollback") and returns plain text
 * without marks, so the client marks the words of the snippet that are close to a word of the query: the same trigram measure
 * (pg_trgm: words padded with two blanks in front and one behind), a contained word, or a prefix of what is being typed.
 */
export type Range = readonly [start: number, end: number];

const WORD = /[\p{L}\p{N}_]+/gu;
const THRESHOLD = 0.4;

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export const queryWords = (query: string): string[] => [...new Set((query.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 2))].slice(0, 12);

/** The character ranges of `text` to mark for `query` (in order, not overlapping). */
export function highlightRanges(text: string, query: string): Range[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const out: Range[] = [];
  for (const m of text.slice(0, 2_000).matchAll(WORD)) {
    const w = m[0].toLowerCase();
    if (words.some((q) => w.includes(q) || (w.length >= 5 && q.includes(w)) || similarity(w, q) >= THRESHOLD)) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
