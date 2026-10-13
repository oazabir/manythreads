// "Remove claim" (PLAN P5-17, SPEC §6.3): the sharer of an answer may take claims out of the copy before it is posted — and nothing else. The text
// of the copy is therefore never anything the sharer wrote: this function takes the answer's own text and the NUMBERS of the citations whose claims
// go, and returns that text with whole sentences deleted. What it returns is a subsequence of what it was given (a test pins it, and the messages
// provider checks it again before it stores a copy), so a removal can shorten an answer and can never add a word to it.
//
// A claim is a sentence that carries the marker `[n]` of a removed citation. Sentences end at `.`, `!`, `?` (and their Arabic, Chinese and
// ellipsis forms) that is followed by white space or the end of the line, after any run of closers and markers that follows it directly
// (`... window [1].`, `... window.[1] Next`). A line that loses every sentence it had goes with its list or quote prefix. Fenced code is never
// touched: a `[3]` inside it is text, not a marker.
//
// One pass over the text, no backtracking: each character is looked at a constant number of times, so 20,000 characters of `[` or of `.` cost
// what 20,000 of `a` do (a hostile-input timing test sits next to the function's tests).

/** What `removeClaims` did. */
export interface ClaimRemoval {
  /** The answer's text after the removal; the same string, untouched, when nothing was removed. */
  body: string;
  /** How many sentences were taken out. */
  sentences: number;
}

const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？', '؟']);
/** What may close a sentence right after its terminator: quotes, brackets and emphasis marks that belong to it. */
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', '»', '*', '_', '`', '~']);

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === ' ' || ch === '　';

/** `[n]` at `i` (one to three digits): its number and the index after the closing bracket, or null. */
function markerAt(text: string, i: number): { n: number; end: number } | null {
  if (text[i] !== '[') return null;
  let j = i + 1;
  let n = 0;
  let digits = 0;
  while (digits < 3 && isDigit(text[j])) {
    n = n * 10 + (text.charCodeAt(j) - 48);
    j += 1;
    digits += 1;
  }
  if (digits === 0 || text[j] !== ']') return null;
  return { n, end: j + 1 };
}

/** The length of a line's prefix that is not prose: indentation, quote marks, a list bullet or number, a heading mark. */
function prefixLength(line: string): number {
  const n = line.length;
  let i = 0;
  for (;;) {
    const before = i;
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i += 1;
    if (line[i] === '>') {
      i += 1;
      if (line[i] === ' ') i += 1;
    } else if ((line[i] === '-' || line[i] === '*' || line[i] === '+') && line[i + 1] === ' ') {
      i += 2;
    } else if (isDigit(line[i])) {
      let j = i;
      while (j < n && j - i < 9 && isDigit(line[j])) j += 1;
      if ((line[j] === '.' || line[j] === ')') && line[j + 1] === ' ') i = j + 2;
    } else if (line[i] === '#') {
      let j = i;
      while (j < n && j - i < 6 && line[j] === '#') j += 1;
      if (line[j] === ' ') i = j + 1;
    }
    if (i === before) return i;
  }
}

/** The text of one line (after its prefix) without the sentences that carry a removed marker. */
function dropSentences(text: string, removed: ReadonlySet<number>): { text: string; dropped: number } {
  const n = text.length;
  let out = '';
  let dropped = 0;
  let start = 0;
  let hit = false;
  const flush = (end: number): void => {
    if (hit) dropped += 1;
    else out += text.slice(start, end);
    start = end;
    hit = false;
  };
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '[') {
      const m = markerAt(text, i);
      if (m !== null) {
        if (removed.has(m.n)) hit = true;
        i = m.end;
      } else {
        i += 1;
      }
      continue;
    }
    if (TERMINATORS.has(ch)) {
      // the terminator, then whatever belongs to the sentence directly after it: more terminators, closers, markers
      let j = i + 1;
      while (j < n) {
        const c = text[j]!;
        if (TERMINATORS.has(c) || CLOSERS.has(c)) {
          j += 1;
          continue;
        }
        const m = c === '[' ? markerAt(text, j) : null;
        if (m === null) break;
        if (removed.has(m.n)) hit = true;
        j = m.end;
      }
      if (j >= n || isSpace(text[j])) {
        let k = j;
        while (k < n && isSpace(text[k])) k += 1;
        flush(k);
        i = k;
      } else {
        i = j; // "3.5", "a.b": a full stop inside a word is not the end of anything
      }
      continue;
    }
    i += 1;
  }
  flush(n);
  return { text: out, dropped };
}

/**
 * The text of an answer without the claims that rest on the citations in `removed` (their `[n]` numbers). `removed` empty: the same text.
 */
export function removeClaims(body: string, removed: ReadonlySet<number>): ClaimRemoval {
  if (removed.size === 0) return { body, sentences: 0 };
  const out: string[] = [];
  let fence: string | null = null;
  let sentences = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    const mark = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null;
    if (fence !== null) {
      out.push(line);
      if (mark === fence) fence = null;
      continue;
    }
    if (mark !== null) {
      fence = mark;
      out.push(line);
      continue;
    }
    const cut = prefixLength(line);
    const kept = dropSentences(line.slice(cut), removed);
    if (kept.dropped === 0) {
      out.push(line);
      continue;
    }
    sentences += kept.dropped;
    const rest = kept.text.trimEnd();
    if (rest.trim() === '') continue; // every sentence of the line went: the line goes with its bullet
    out.push(line.slice(0, cut) + rest);
  }
  if (sentences === 0) return { body, sentences: 0 };
  // paragraphs that lost all their lines leave runs of blank lines: one is enough (outside fenced code, where nothing was touched)
  const squeezed: string[] = [];
  let inFence: string | null = null;
  let blanks = 0;
  for (const line of out) {
    const trimmed = line.trimStart();
    const mark = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null;
    if (inFence !== null) {
      squeezed.push(line);
      if (mark === inFence) inFence = null;
      continue;
    }
    if (mark !== null) {
      inFence = mark;
      blanks = 0;
      squeezed.push(line);
      continue;
    }
    if (line.trim() === '') {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    squeezed.push(line);
  }
  return { body: squeezed.join('\n').trim(), sentences };
}

/** True when `copy` can be made from `original` by deleting characters only: the check that a copy added nothing. Linear. */
export function isSubsequence(copy: string, original: string): boolean {
  let j = 0;
  for (let i = 0; i < original.length && j < copy.length; i += 1) {
    if (original.charCodeAt(i) === copy.charCodeAt(j)) j += 1;
  }
  return j === copy.length;
}
