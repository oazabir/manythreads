// "Remove claim" (PLAN P5-17, SPEC §6.3): the sharer of an answer may take claims out of the copy before it is posted — and nothing else. The text
// of the copy is therefore never anything the sharer wrote: this function takes the answer's own text and the NUMBERS of the citations whose claims
// go, and returns that text with whole sentences deleted. What it returns is a subsequence of what it was given (a test pins it, and the messages
// provider checks it again before it stores a copy), so a removal can shorten an answer and can never add a word to it.
//
// A claim is a sentence that carries the marker `[n]` of a removed citation. The model is told to write markers wherever it likes (`[1], [2]`,
// before the stop, after it, after a space, at the start of a line), and what is stored is its text, so the segmentation FAILS TOWARD REMOVING
// MORE: where the extent of a sentence is ambiguous the claim is never left behind.
//
//   * The unit is a BLOCK, not a line: a paragraph (hard-wrapped lines included), a list item with its continuation lines, a quote, a heading, a
//     table row (which goes whole). Sentences are found across the lines of a block, and a block that loses every sentence goes whole, with its
//     bullet. Fenced code is never touched: a `[3]` inside it is text, not a marker.
//   * A sentence ends at `.`, `!`, `?` (and their Arabic, Chinese and ellipsis forms), after any run of closers, markers and commas that follow it
//     directly, when white space (a space or a line break) or the end follows — and the next word does not begin in lower case or with a digit
//     (`... for $4M. according to the board [2].` is one sentence) and the stop does not close an abbreviation (`e.g.`, `U.S.`, `Dr.`, an initial).
//   * A marker group written after the stop and a space (`Revenue grew 4%. [2] Next.`, `... . [1], [2]`) belongs to the sentence BEFORE it.
//   * After a block was cut, a removed marker still in it (nothing should be) takes the whole block with it.
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

const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？', '؟']);
/** What may close a sentence right after its terminator: quotes, brackets and emphasis marks that belong to it. */
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’', '»', '*', '_', '`', '~']);
/** Words whose stop does not end a sentence (lower-cased, without the stop). One letter is always an initial. */
const ABBREVIATIONS = new Set(['dr', 'mr', 'ms', 'mrs', 'vs', 'st', 'prof', 'inc', 'ltd', 'etc', 'approx', 'fig', 'cf', 'al', 'eg', 'ie', 'jr', 'sr']);
const SNIPPET = 400;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const isWs = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ' ' || ch === '　';
const isLower = (ch: string): boolean => ch === ch.toLowerCase() && ch !== ch.toUpperCase();
const isLetter = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();

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

/** Is there a marker at `i`, or after the horizontal white space and line breaks that start there? */
function markerAfterSpace(text: string, i: number): boolean {
  let k = i;
  while (k < text.length && isWs(text[k])) k += 1;
  return markerAt(text, k) !== null;
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

/** The text of one block without the sentences that carry a removed marker. */
function dropSentences(text: string, removed: ReadonlySet<number>): { text: string; dropped: string[] } {
  const n = text.length;
  let out = '';
  const dropped: string[] = [];
  let start = 0;
  let hit = false;
  const flush = (end: number): void => {
    if (hit) {
      const said = text.slice(start, end).replace(/\s+/g, ' ').trim();
      dropped.push(said.length <= SNIPPET ? said : `${said.slice(0, SNIPPET - 1)}…`);
    } else {
      out += text.slice(start, end);
    }
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
    if (!TERMINATORS.has(ch)) {
      i += 1;
      continue;
    }
    // the stop, then whatever belongs to the sentence after it: more stops, closers, a marker group (`[1][2]`, `[1], [2]`, `. [2]`)
    let j = i + 1;
    while (j < n) {
      const c = text[j]!;
      if (TERMINATORS.has(c) || CLOSERS.has(c)) {
        j += 1;
        continue;
      }
      if (c === '[') {
        const m = markerAt(text, j);
        if (m === null) break;
        if (removed.has(m.n)) hit = true;
        j = m.end;
        continue;
      }
      if ((c === ',' || c === ';') && markerAfterSpace(text, j + 1)) {
        j += 1;
        continue;
      }
      if (isWs(c)) {
        // white space, then a marker: the marker is this sentence's (the model writes `claim. [2]`)
        let k = j;
        while (k < n && isWs(text[k])) k += 1;
        if (markerAt(text, k) !== null) {
          j = k;
          continue;
        }
      }
      break;
    }
    if (j >= n) {
      i = n;
      continue;
    }
    if (!isWs(text[j])) {
      i = j; // "3.5", "a.b": a stop inside a word is not the end of anything
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
    flush(k);
    i = k;
  }
  flush(n);
  return { text: out, dropped };
}

/** Does `text` still hold a marker of a removed citation? */
function holdsMarker(text: string, removed: ReadonlySet<number>): boolean {
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    const m = markerAt(text, i);
    if (m !== null && removed.has(m.n)) return true;
  }
  return false;
}

/**
 * The text of an answer without the claims that rest on the citations in `removed` (their `[n]` numbers). `removed` empty: the same text.
 */
export function removeClaims(body: string, removed: ReadonlySet<number>): ClaimRemoval {
  if (removed.size === 0 || !holdsMarker(body, removed)) return { body, sentences: 0, removed: [] };

  // pass 1: the structure. Raw lines (blank, fenced code), table rows, and blocks of prose (a paragraph, a list item, a quote, a heading)
  type Block = { kind: 'block'; prefix: string; first: string; rest: string[]; raw: string[] };
  type Seg = { kind: 'raw'; line: string } | { kind: 'row'; line: string } | Block;
  const segs: Seg[] = [];
  let cur: Block | null = null;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    const mark = trimmed.startsWith('```') ? '```' : trimmed.startsWith('~~~') ? '~~~' : null;
    if (fence !== null) {
      segs.push({ kind: 'raw', line });
      if (mark === fence) fence = null;
      continue;
    }
    if (mark !== null || line.trim() === '' || trimmed.startsWith('|')) {
      if (cur !== null) {
        segs.push(cur);
        cur = null;
      }
      if (mark !== null) {
        fence = mark;
        segs.push({ kind: 'raw', line });
      } else {
        segs.push(line.trim() === '' ? { kind: 'raw', line } : { kind: 'row', line });
      }
      continue;
    }
    const cut = prefixLength(line);
    const heading = trimmed.startsWith('#');
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

  // pass 2: each block loses the sentences that carry a removed marker (a table row goes whole)
  const out: string[] = [];
  const said: string[] = [];
  let touched = false;
  for (const seg of segs) {
    if (seg.kind === 'raw') {
      out.push(seg.line);
      continue;
    }
    if (seg.kind === 'row') {
      if (holdsMarker(seg.line, removed)) {
        said.push(seg.line.replace(/\s+/g, ' ').trim().slice(0, SNIPPET));
        touched = true;
      } else {
        out.push(seg.line);
      }
      continue;
    }
    const text = [seg.first, ...seg.rest].join('\n');
    if (!holdsMarker(text, removed)) {
      out.push(...seg.raw);
      continue;
    }
    const cutText = dropSentences(text, removed);
    touched = true;
    if (holdsMarker(cutText.text, removed)) {
      // nothing of a removed claim may stay: a marker that survived the cut takes the whole block with it
      said.push(...cutText.dropped, text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET));
      continue;
    }
    said.push(...cutText.dropped);
    const rest = cutText.text.trim();
    if (rest !== '') out.push(...(seg.prefix + rest).split('\n'));
  }
  if (!touched) return { body, sentences: 0, removed: [] };

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
  return { body: squeezed.join('\n').trim(), sentences: said.length, removed: said };
}

/** True when `copy` can be made from `original` by deleting characters only: the check that a copy added nothing. Linear. */
export function isSubsequence(copy: string, original: string): boolean {
  let j = 0;
  for (let i = 0; i < original.length && j < copy.length; i += 1) {
    if (original.charCodeAt(i) === copy.charCodeAt(j)) j += 1;
  }
  return j === copy.length;
}
