import { MARKER_OPEN, NO_NUMBERS, holdsMarker, isDigit, isWs, markerAt } from './markers.ts';

const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？', '؟', '۔', '।', '॥']);
/** Stops of scripts that are written without a space after them: the sentence ends there whatever follows. */
const UNSPACED_STOPS = new Set(['。', '！', '？']);
/** What may close a sentence right after its terminator: quotes, brackets and emphasis marks that belong to it. */
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', '»', '*', '_', '`', '~', '」', '』', '）', '］', '】']);
/** Words whose stop does not end a sentence (lower-cased, without the stop). One letter is always an initial. */
const ABBREVIATIONS = new Set(['dr', 'mr', 'ms', 'mrs', 'vs', 'st', 'prof', 'inc', 'ltd', 'etc', 'approx', 'fig', 'cf', 'al', 'eg', 'ie', 'jr', 'sr']);

const isLower = (ch: string): boolean => ch === ch.toLowerCase() && ch !== ch.toUpperCase();
const isLetter = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();
const ANY_LETTER = /^[\p{L}\p{M}]$/u;
/** The stops that end an ordinary statement; the others (`?`, `!`, `…` and their forms) may sit inside quoted speech or a name (`Yahoo! Finance`). */
const PERIODS = new Set(['.', '。', '।', '۔', '॥']);
/** The length (1 or 2 UTF-16 units) of the letter (or combining mark) of any script, cased or not, that starts at `i`, or 0. */
function letterAt(text: string, i: number): number {
  const cp = text.codePointAt(i);
  if (cp === undefined) return 0;
  const ch = String.fromCodePoint(cp);
  return ANY_LETTER.test(ch) ? ch.length : 0;
}
/** The same for the letter that ENDS at `i` (looking back, by code point). */
function letterEndingAt(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
    const h = text.charCodeAt(i - 1);
    if (h >= 0xd800 && h <= 0xdbff) return letterAt(text, i - 1) === 2 ? 2 : 0;
  }
  return letterAt(text, i) === 1 ? 1 : 0;
}

/** The length of a line's leading marks: indentation, quote marks, a list bullet or number, a heading mark. */
export function prefixLength(line: string): number {
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

/** Indentation and quote marks of a continuation line (never a bullet: a line with one starts a block of its own). */
export function continuationLength(line: string): number {
  let i = 0;
  for (;;) {
    const before = i;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
    if (line[i] === '>') {
      i += 1;
      if (line[i] === ' ') i += 1;
    }
    if (i === before) return i;
  }
}

/** Does the stop at `i` close an abbreviation or an initial? (`e.g.`, `U.S.`, `Dr.`, `J.`) */
function closesAbbreviation(text: string, i: number): boolean {
  if (text[i] !== '.') return false;
  let j = i;
  while (j > 0 && i - j < 8 && isLetter(text[j - 1]!)) j -= 1;
  const word = text.slice(j, i);
  if (word.length === 0) return false;
  if (word.length === 1) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** The runs of backticks of a text by their length: where each starts, and a cursor that only moves forward. */
function backtickRuns(text: string): Map<number, { starts: number[]; at: number }> {
  const runs = new Map<number, { starts: number[]; at: number }>();
  let i = text.indexOf('`');
  while (i >= 0) {
    let r = 1;
    while (text[i + r] === '`') r += 1;
    const list = runs.get(r);
    if (list) list.starts.push(i);
    else runs.set(r, { starts: [i], at: 0 });
    i = text.indexOf('`', i + r);
  }
  return runs;
}

/** The start of the next run of exactly `r` backticks at or after `from`, or -1. Openers advance, so the cursor does too. */
function nextRun(runs: Map<number, { starts: number[]; at: number }>, r: number, from: number): number {
  const list = runs.get(r);
  if (!list) return -1;
  while (list.at < list.starts.length && list.starts[list.at]! < from) list.at += 1;
  return list.at < list.starts.length ? list.starts[list.at]! : -1;
}

/** Characters that open a wrapper around a marker or a few words (`(see [2])`, `"[2]"`, `「[2]」`); the closers mirror them. */
const WRAP_OPEN = new Set(['(', '[', '{', '（', '［', '【', '｛', '「', '『', '“', '‘', '«', '〈', '《']);
const WRAP_CLOSE = new Set([')', ']', '}', '）', '］', '】', '｝', '」', '』', '”', '’', '»', '〉', '》']);
const WORD = /[\p{L}\p{N}\p{M}]/u;

/** The length (in UTF-16 units) of the word character at `i` (a letter, a digit or a mark of any script), or 0. */
function wordLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0;
  const cp = text.codePointAt(i)!;
  return WORD.test(String.fromCodePoint(cp)) ? (cp > 0xffff ? 2 : 1) : 0;
}

export interface Unit {
  start: number;
  end: number;
  /** The unit holds a removed marker (or was taken with a neighbour). */
  hit: boolean;
  /** A removed marker in it has no word character before it in the unit. */
  boundary: boolean;
  /** It follows a split that may have been an abbreviation's stop or a short word's: if it goes, the unit before it goes too. */
  soft: boolean;
  /** No word character at all in the unit (a marker and decoration only). */
  wordless: boolean;
}

/**
 * The stop at `i` may close something that is not a sentence: a word of one to four letters (any script, any case: `Sen.`, `Gov.`, `ca.`, `St.`,
 * `done.`), a number (`Am 3. Mai`), or a token with a dot inside it (`v2.3`, `a.txt`, `example.com/a.b`, `p.m`, `Ph.D`). The sentence may go on
 * after it.
 */
function doubtfulBefore(text: string, i: number): boolean {
  let count = 0;
  let q = i - 1;
  while (count < 5 && q >= 0) {
    const w = letterEndingAt(text, q);
    if (w === 0) break;
    count += 1;
    q -= w;
  }
  if (count >= 1 && count <= 4) return true;
  // a number before the stop (`Am 3. Mai`, `in 2023.`): an ordinal, or a year that ends nothing
  let d = i - 1;
  while (d >= 0 && i - d <= 12 && isDigit(text[d])) d -= 1;
  if (d < i - 1 && (d < 0 || isWs(text[d]))) return true;
  for (let r = i - 1, steps = 0; r >= 0 && steps < 64 && !isWs(text[r]); r -= 1, steps += 1) {
    if (text[r] === '.') return true;
  }
  return false;
}

/**
 * One block cut into sentence units, each marked with what the removal needs to know.
 *
 * The block is cut into sentence units (a stop, then white space and a word that is not in lower case or a digit; or a stop of a script written
 * without spaces; or a stop that a marker group follows directly). A removed marker belongs to the unit it sits in. Where it sits decides one
 * thing: if no word character (a letter, digit or mark of any script) lies between the start of its unit and the marker — only white space,
 * punctuation, symbols, quotes, brackets, emphasis, a link address, or a few words inside an opening bracket or quote that the marker is also
 * inside — the marker is at a sentence BOUNDARY, and it may belong to the sentence before it or be the prefix of this one: both go. Otherwise it
 * is the unit's own suffix or inline marker, and this unit alone goes. No list of decorations has to be complete: only word characters count.
 */
export function segmentBlock(text: string, removed: ReadonlySet<number>): Unit[] {
  const n = text.length;
  const units: Unit[] = [];
  let start = 0;
  let softNext = false; // the unit that is starting follows a doubtful split
  let sawWord = false;
  let hit = false; // the unit holds a removed marker
  let boundary = false; // one of them has no word character before it in the unit
  let words = false; // a word character has been seen (outside a leading wrapper that is still open)
  let lead = 0; // wrappers opened before any word and not yet closed
  let pending = false; // words inside those wrappers: they count only once the wrapper closes
  let quoteLead = false;
  const endUnit = (end: number, soft = false): void => {
    units.push({ start, end, hit, boundary, soft: softNext, wordless: !sawWord });
    softNext = soft;
    sawWord = false;
    start = end;
    hit = false;
    boundary = false;
    words = false;
    lead = 0;
    pending = false;
    quoteLead = false;
  };
  const closeWrapper = (): void => {
    if (lead === 0) return;
    lead -= 1;
    if (lead === 0 && pending) {
      words = true;
      pending = false;
    }
  };
  let runs: Map<number, { starts: number[]; at: number }> | undefined;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '`') {
      // an inline code span is one piece, and counts as a word: its stops end nothing, and a removed marker in it takes the unit
      let r = 1;
      while (text[i + r] === '`') r += 1;
      runs ??= backtickRuns(text);
      const closeAt = nextRun(runs, r, i + r);
      if (closeAt < 0) {
        i += r;
        continue;
      }
      if (holdsMarker(text.slice(i + r, closeAt), removed)) {
        hit = true;
        if (!words) boundary = true;
      }
      sawWord = true;
      if (lead > 0) pending = true;
      else words = true;
      i = closeAt + r;
      continue;
    }
    if (MARKER_OPEN[ch] !== undefined) {
      const m = markerAt(text, i, removed);
      if (m !== null) {
        if (m.hit) {
          hit = true;
          if (!words) boundary = true;
        }
        i = m.end;
        if (text[i] === '(') {
          // `[2](https://…)`: the address of a link that has the marker for its label
          let q = i + 1;
          while (q < Math.min(n, i + 258) && text[q] !== ')' && !isWs(text[q])) q += 1;
          if (text[q] === ')') i = q + 1;
        }
        continue;
      }
    }
    if (ch === '<' && /[A-Za-z/]/.test(text[i + 1] ?? '')) {
      // an HTML tag (`<sup>`) is decoration, not words
      let q = i + 1;
      while (q < Math.min(n, i + 40) && text[q] !== '>' && !isWs(text[q])) q += 1;
      if (text[q] === '>') {
        i = q + 1;
        continue;
      }
    }
    if (WRAP_OPEN.has(ch)) {
      if (!words) lead += 1;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (quoteLead) {
        quoteLead = false;
        closeWrapper();
      } else if (!words) {
        quoteLead = true;
        lead += 1;
      }
      i += 1;
      continue;
    }
    if (WRAP_CLOSE.has(ch)) {
      closeWrapper();
      if (ch === ']' && text[i + 1] === '(') {
        // the address of a link: not words
        let q = i + 2;
        while (q < Math.min(n, i + 258) && text[q] !== ')' && !isWs(text[q])) q += 1;
        if (text[q] === ')') {
          i = q + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }
    if (!TERMINATORS.has(ch)) {
      const w = wordLength(text, i);
      if (w > 0) {
        sawWord = true;
        if (lead > 0) pending = true;
        else words = true;
        i += w;
      } else {
        i += 1;
      }
      continue;
    }
    // a stop, with the stops and closers that follow it directly
    let j = i + 1;
    let last = ch;
    while (j < n) {
      const c = text[j]!;
      if (TERMINATORS.has(c)) last = c;
      else if (!CLOSERS.has(c)) break;
      j += 1;
    }
    if (j >= n) {
      i = n;
      continue;
    }
    // a question or an exclamation, a run of stops (`...`), or a closing quote or bracket after the stop (`Friday?" Dana asked`, `done." Warren`):
    // the sentence may go on after it, so the next unit is soft
    const loud = !PERIODS.has(ch) || j - i > 1;
    if (!isWs(text[j])) {
      // no space after it: a stop inside a word ("3.5") ends nothing, a stop of a script written without spaces does, and so does a stop that a
      // marker group follows directly (the group then opens the next unit and is judged there)
      if (UNSPACED_STOPS.has(last) || markerAt(text, j, NO_NUMBERS) !== null) endUnit(j, loud);
      i = j;
      continue;
    }
    let k = j;
    while (k < n && isWs(text[k])) k += 1;
    // a lower-case word or a digit after the stop, or an abbreviation before it: the sentence goes on (the claim is never cut short)
    const next = text[k];
    if (next === undefined) {
      i = n;
      continue;
    }
    if (isLower(next) || isDigit(next) || next === ',' || next === ';' || next === ')' || closesAbbreviation(text, i)) {
      i = k;
      continue;
    }
    // a doubtful split: a short word before the stop (`Sen.`, `ca.`, `done.`), or something that is not a letter after it (`€3M`)
    endUnit(k, loud || (ch === '.' && doubtfulBefore(text, i)) || letterAt(text, k) === 0);
    i = k;
  }
  endUnit(n);
  return units;
}
