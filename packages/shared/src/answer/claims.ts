// "Remove claim" (PLAN P5-17, SPEC §6.3): the sharer of an answer may take claims out of the copy before it is posted — and nothing else. The text
// of the copy is therefore never anything the sharer wrote: this function takes the answer's own text and the NUMBERS of the citations whose claims
// go, and returns that text with whole sentences deleted. What it returns is a subsequence of what it was given (a test pins it, and the messages
// provider checks it again before it stores a copy), so a removal can shorten an answer and can never add a word to it.
//
// A claim is a sentence unit that carries the marker `[n]` of a removed citation. The model is told to write markers wherever it likes (`[1], [2]`,
// before the stop, after it, tight to it, after a space, at the start of a line, wrapped in emphasis, brackets, quotes or a link), and what is
// stored is its text, so the segmentation FAILS TOWARD REMOVING MORE: where the extent of a sentence is ambiguous the claim is never left behind.
//
//   * The unit is a BLOCK, not a line: a paragraph (hard-wrapped lines included), a list item with its continuation lines, a quote, a heading, a
//     table row (which goes whole). A block is cut into sentence units; a block that loses every unit goes whole, with its bullet.
//   * A unit ends at `.`, `!`, `?` (and their Arabic, Indic, Chinese and ellipsis forms), after any run of stops and closers, when white space
//     follows — and the next word does not begin in lower case or with a digit and the stop does not close an abbreviation (`e.g.`, `U.S.`,
//     `Dr.`, an initial) — or when the stop is of a script written without spaces (`。！？`), or when a marker group follows the stop directly.
//   * A split can be wrong, and no list of abbreviations is complete (`Sen.`, `Gov.`, `Corp.`, `Mt.`, `ca. €3M`): so a unit that FOLLOWS a doubtful
//     split — a `.` after a word of four letters or fewer (any script, any case), after a number (`Am 3. Mai`) or after a token with a dot inside
//     it (`v2.3`, `a.txt`); a `?`, `!` or `…`; a run of stops or a closing quote or bracket after the stop (`...`, `Friday?" Dana`, `done." Warren`);
//     or a next character that is not a letter — is marked SOFT, and
//     when a soft unit is taken the unit before it is taken too (backwards, so doubtful splits chain). The documented price is one innocent
//     neighbour when a short word ends a sentence and the next one carries the marker; the claim itself is never left half behind.
//   * One positional rule decides where a removed marker group belongs, whatever decorates it (`**[2]**`, `\[2\]`, `([2])`, `(see [2])`, `"[2]"`,
//     `「[2]」`, `[[2]](url)`, `<sup>[2]</sup>`, `^[2]`): it belongs to the unit it sits in; and if NO word character (a letter, a digit or a mark of
//     any script) lies between the start of the unit and the group — only white space, punctuation, symbols, decoration, a link address, or words
//     inside an opening bracket or quote that the group is also inside — it is at a sentence BOUNDARY: it may be the suffix of the sentence before
//     or the prefix of this one, so BOTH go (the documented price is one innocent neighbour). A group after words is the unit's own: this unit goes.
//     No list of decorations has to be complete; only word characters count. The same holds across blocks: a block whose first unit has no word
//     character at all (`[2]` alone in a paragraph or a list item) also takes the last unit of the block immediately before it.
//   * Markers are `[2]`, `[1, 2]`, `[1-3]`, `[ 2 ]`, `［2］` and `【2】`, with a backslash allowed before the closing bracket (the client unescapes it);
//     a group counts as removed when ANY number in it is.
//   * Fenced code with a removed marker in it goes whole; a fence with no closing line is ordinary prose (it never shields what follows); an
//     inline code span is read as one piece (its stops are no sentence ends, it counts as a word) and a removed marker in it takes its unit.
//   * After a block was cut, a removed marker still in it (nothing should be) takes the whole block, and what is left is read again.
//
// One pass over each block, no backtracking: every character is looked at a constant number of times, so 20,000 characters of `[` or of `.` cost
// what 20,000 of `a` do (a hostile-input timing test sits next to the function's tests).

/** What `removeClaims` did. */
export interface ClaimRemoval {
  /** The answer's text after the removal; the same string, untouched, when nothing was removed. */
  body: string;
  /** How many sentences (or whole blocks) were taken out. */
  sentences: number;
  /** The words that were taken out, one entry per sentence, trimmed and cut at 400 characters: what the sharer's preview shows. */
  removed: string[];
}

const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？', '؟', '۔', '।', '॥']);
/** Stops of scripts that are written without a space after them: the sentence ends there whatever follows. */
const UNSPACED_STOPS = new Set(['。', '！', '？']);
/** What may close a sentence right after its terminator: quotes, brackets and emphasis marks that belong to it. */
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', '»', '*', '_', '`', '~', '」', '』', '）', '］', '】']);
/** Words whose stop does not end a sentence (lower-cased, without the stop). One letter is always an initial. */
const ABBREVIATIONS = new Set(['dr', 'mr', 'ms', 'mrs', 'vs', 'st', 'prof', 'inc', 'ltd', 'etc', 'approx', 'fig', 'cf', 'al', 'eg', 'ie', 'jr', 'sr']);
const SNIPPET = 400;

/** `text` cut to `max` UTF-16 units with an ellipsis, never between the two halves of a surrogate pair. */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
/** The same without an ellipsis: the head of a string, whole code points only. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
const MARKER_OPEN: Readonly<Record<string, string>> = { '[': ']', '［': '］', '【': '】' };
const NO_NUMBERS: ReadonlySet<number> = new Set();

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
/** White space of every kind that reaches a reader as a gap: the ASCII ones, NBSP, the Unicode spaces, and the zero-width characters. */
const isWs = (ch: string | undefined): boolean => {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200d) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x2060 || c === 0x3000 || c === 0xfeff
  );
};
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

/**
 * A marker group at `i`: `[n]`, `[a, b]`, `[a-b]`, `[ n ]`, `［n］`, `【n】` (numbers of one to three digits, at most 40 characters in all).
 * `hit` says whether any number of it (any number of a range) is in `removed`.
 */
function markerAt(text: string, i: number, removed: ReadonlySet<number>): { end: number; hit: boolean } | null {
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

/** The length of a line's leading marks: indentation, quote marks, a list bullet or number, a heading mark. */
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

/** Indentation and quote marks of a continuation line (never a bullet: a line with one starts a block of its own). */
function continuationLength(line: string): number {
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

/** Does `text` hold a marker group of a removed citation? */
function holdsMarker(text: string, removed: ReadonlySet<number>): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (MARKER_OPEN[text[i]!] === undefined) continue;
    if (markerAt(text, i, removed)?.hit === true) return true;
  }
  return false;
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

interface Unit {
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
function segmentBlock(text: string, removed: ReadonlySet<number>): Unit[] {
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

/**
 * The text of one block without the units that are hit. A removed marker at a boundary takes the unit before it, a unit that is hit takes the
 * unit before it when its own split was doubtful (and so on back: soft splits chain), and `forceLast` (a marker-only block follows) takes the
 * last unit.
 */
function assembleBlock(text: string, units: Unit[], forceLast: boolean): { text: string; dropped: string[]; any: boolean } {
  for (let u = 1; u < units.length; u += 1) {
    if (units[u]!.boundary) units[u - 1]!.hit = true;
  }
  if (forceLast && units.length > 0) units[units.length - 1]!.hit = true;
  for (let u = units.length - 1; u >= 1; u -= 1) {
    if (units[u]!.hit && units[u]!.soft) units[u - 1]!.hit = true;
  }
  let any = false;
  let out = '';
  const dropped: string[] = [];
  for (const unit of units) {
    if (unit.hit) {
      any = true;
      const said = text.slice(unit.start, unit.end).replace(/\s+/g, ' ').trim();
      if (said !== '') dropped.push(clipText(said, SNIPPET));
    } else {
      out += text.slice(unit.start, unit.end);
    }
  }
  return { text: out, dropped, any };
}

/** A table row: starts and ends with a pipe and has another inside (`#1 overall [2].` or `| a` is prose, as the reader draws it). */
function isTableRow(trimmed: string): boolean {
  const t = trimmed.trimEnd();
  return t.length >= 3 && t.startsWith('|') && t.endsWith('|') && t.indexOf('|', 1) < t.length - 1;
}

/** The mark of a fence line (a line that opens or closes a fenced block), or null. */
function fenceMark(line: string): string | null {
  const t = line.trimStart();
  return t.startsWith('```') ? '```' : t.startsWith('~~~') ? '~~~' : null;
}

/**
 * The text of an answer without the claims that rest on the citations in `removed` (their `[n]` numbers). `removed` empty: the same text.
 */
export function removeClaims(body: string, removed: ReadonlySet<number>): ClaimRemoval {
  if (removed.size === 0 || !holdsMarker(body, removed)) return { body, sentences: 0, removed: [] };

  // pass 1: the structure. Raw lines (blank), fenced blocks, table rows, and blocks of prose (a paragraph, a list item, a quote, a heading)
  type Block = { kind: 'block'; prefix: string; first: string; rest: string[]; raw: string[] };
  type Seg = { kind: 'raw'; line: string } | { kind: 'row'; line: string } | { kind: 'fence'; lines: string[] } | Block;
  const segs: Seg[] = [];
  let cur: Block | null = null;
  const lines = body.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    const trimmed = line.trimStart();
    const mark = fenceMark(line);
    if (mark !== null) {
      // a fence is a fence only when something closes it: an opener with no closing line is a line of prose and shields nothing after it
      let close = -1;
      for (let k = li + 1; k < lines.length; k += 1) {
        if (fenceMark(lines[k]!) === mark) {
          close = k;
          break;
        }
      }
      if (close >= 0) {
        if (cur !== null) {
          segs.push(cur);
          cur = null;
        }
        segs.push({ kind: 'fence', lines: lines.slice(li, close + 1) });
        li = close;
        continue;
      }
    }
    if (line.trim() === '' || isTableRow(trimmed)) {
      if (cur !== null) {
        segs.push(cur);
        cur = null;
      }
      segs.push(line.trim() === '' ? { kind: 'raw', line } : { kind: 'row', line });
      continue;
    }
    const cut = prefixLength(line);
    const heading = /^ {0,3}#{1,6} /.test(line);
    if (cur === null || cut > continuationLength(line) || heading) {
      if (cur !== null) segs.push(cur);
      cur = { kind: 'block', prefix: line.slice(0, cut), first: line.slice(cut), rest: [], raw: [line] };
      if (heading) {
        segs.push(cur);
        cur = null;
      }
      continue;
    }
    cur.rest.push(line.slice(continuationLength(line)));
    cur.raw.push(line);
  }
  if (cur !== null) segs.push(cur);

  // pass 2: each block loses the units that carry a removed marker (a table row and a fenced block go whole)
  const units = segs.map((seg) => (seg.kind === 'block' ? segmentBlock([seg.first, ...seg.rest].join('\n'), removed) : null));
  // a block whose first unit holds a removed marker and nothing else (`[2]` alone in a paragraph, or a list item) takes the last unit of the
  // block right before it (blank lines apart) as well: the boundary rule, across blocks
  const forced = segs.map(() => false);
  let previous = -1;
  segs.forEach((seg, idx) => {
    if (seg.kind === 'raw' && seg.line.trim() === '') return;
    const mine = units[idx];
    if (mine !== null && mine !== undefined && mine.length > 0 && mine[0]!.hit && mine[0]!.wordless && previous >= 0) forced[previous] = true;
    previous = seg.kind === 'block' ? idx : -1;
  });
  const out: string[] = [];
  const fenced = new Set<number>();
  const said: string[] = [];
  let touched = false;
  for (const [idx, seg] of segs.entries()) {
    if (seg.kind === 'raw') {
      out.push(seg.line);
      continue;
    }
    if (seg.kind === 'fence') {
      if (holdsMarker(seg.lines.join('\n'), removed)) {
        said.push(headOf(seg.lines.join(' ').replace(/\s+/g, ' ').trim(), SNIPPET));
        touched = true;
      } else {
        for (const l of seg.lines) {
          fenced.add(out.length);
          out.push(l);
        }
      }
      continue;
    }
    if (seg.kind === 'row') {
      if (holdsMarker(seg.line, removed)) {
        said.push(headOf(seg.line.replace(/\s+/g, ' ').trim(), SNIPPET));
        touched = true;
      } else {
        out.push(seg.line);
      }
      continue;
    }
    const text = [seg.first, ...seg.rest].join('\n');
    const cutText = assembleBlock(text, units[idx]!, forced[idx]!);
    if (!cutText.any) {
      out.push(...seg.raw);
      continue;
    }
    touched = true;
    if (holdsMarker(cutText.text, removed)) {
      // nothing of a removed claim may stay: a marker that survived the cut takes the whole block with it
      said.push(...cutText.dropped, headOf(text.replace(/\s+/g, ' ').trim(), SNIPPET));
      continue;
    }
    said.push(...cutText.dropped);
    const rest = cutText.text.trim();
    if (rest !== '') out.push(...(seg.prefix + rest).split('\n'));
  }
  if (!touched) return { body, sentences: 0, removed: [] };

  // paragraphs that lost all their lines leave runs of blank lines: one is enough (never inside the code that was kept)
  const squeezed: string[] = [];
  let blanks = 0;
  for (const [index, line] of out.entries()) {
    if (fenced.has(index)) {
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
  const result = squeezed.join('\n').trim();
  // taking words out can join what was apart (`[` before the cut and `2]` after it): what is left is read again, and it only ever gets shorter
  if (holdsMarker(result, removed)) {
    const again = removeClaims(result, removed);
    return { body: again.body, sentences: said.length + again.sentences, removed: [...said, ...again.removed] };
  }
  return { body: result, sentences: said.length, removed: said };
}

/** True when `copy` can be made from `original` by deleting characters only: the check that a copy added nothing. Linear. */
export function isSubsequence(copy: string, original: string): boolean {
  let j = 0;
  for (let i = 0; i < original.length && j < copy.length; i += 1) {
    if (original.charCodeAt(i) === copy.charCodeAt(j)) j += 1;
  }
  return j === copy.length;
}
