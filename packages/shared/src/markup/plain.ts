import { findCodeRanges } from './code.ts';

/*
 * Markdown to plain text, in linear time.
 *
 * Every step is a scanner or an anchored, unambiguous regex: no quantifier is nested in another, nothing is retried from
 * every start position. Where a construct has an unbounded inner part (link labels and destinations, emphasis spans,
 * trailing blanks) the scan keeps a lookup table or a pointer, so that no position is examined more than a few times.
 * `test/markup/plain.test.ts` holds 40,000-character hostile inputs with a time limit; keep it passing.
 */

// Private-use characters mark held text (code, escapes, entity refs); input that already holds them has them removed.
const OPEN = '';
const CLOSE = '';
const HOLD = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

const HTML_TAGS = new Set(
  (
    'a b i u s em strong del ins sub sup br hr p div span img kbd mark details summary h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tr td th ' +
    'blockquote pre code'
  ).split(' '),
);
const ENTITY_KINDS = ['thread:', 'file:', 'page:', 'task:'];
const ENTITY_MAX = 512;

const ESCAPABLE = /\\([!-/:-@[-`{-~])/g;
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const SPACE = /\s/;
const AUTOLINK_SCHEME = /^(?:https?|ftp|mailto):[^\s<>]+$/i;
const AUTOLINK_EMAIL = /^[^\s<>@]+@[^\s<>@]+$/;
const DASH_CELL = /^:?-+:?$/;
const REF_DEFINITION = /^ {0,3}\[[^\]]+\]:\s+\S+(\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const QUOTE = /^[ \t]*(?:>[ \t]?)+/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

// ---- character classes -------------------------------------------------------------------------------------------

const isBlank = (c: number): boolean => c === 32 || c === 9;

/** `\s` of a JS regex, for the character at `i`. */
function isSpaceAt(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  return c >= 160 && SPACE.test(text[i] as string);
}

function isAlnumCodePoint(cp: number): boolean {
  if (cp < 128) return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
  return LETTER_OR_NUMBER.test(String.fromCodePoint(cp));
}

/** `[\p{L}\p{N}]` for the code point starting at `i`. */
function alnumAt(text: string, i: number): boolean {
  const cp = text.codePointAt(i);
  return cp !== undefined && isAlnumCodePoint(cp);
}

/** `[\p{L}\p{N}]` for the code point that ends just before `i`. */
function alnumBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  let cp = text.charCodeAt(i - 1);
  if (cp >= 0xdc00 && cp <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) cp = (high - 0xd800) * 0x400 + (cp - 0xdc00) + 0x10000;
  }
  return isAlnumCodePoint(cp);
}

function skipBlank(text: string, i: number): number {
  while (i < text.length && isBlank(text.charCodeAt(i))) i++;
  return i;
}

function trimEndBlank(text: string, end: number, floor = 0): number {
  while (end > floor && isBlank(text.charCodeAt(end - 1))) end--;
  return end;
}

// ---- block level: one line at a time ----------------------------------------------------------------------------

/** `|---|:-:|` and `--- | ---`: a table's header rule. */
function isTableRule(line: string): boolean {
  if (!line.includes('|')) return false;
  let start = skipBlank(line, 0);
  let end = trimEndBlank(line, line.length, start);
  if (line[start] === '|') start++;
  if (end > start && line[end - 1] === '|') end--;
  if (end <= start) return false;
  let at = start;
  for (;;) {
    const bar = line.indexOf('|', at);
    const cellEnd = bar === -1 || bar > end ? end : bar;
    const a = skipBlank(line, at);
    const b = trimEndBlank(line, cellEnd, a);
    if (!DASH_CELL.test(line.slice(a, b))) return false;
    if (cellEnd === end) return true;
    at = cellEnd + 1;
  }
}

/** A thematic break (`---`, `* * *`, `___`) or a setext underline (`====`). */
function isRuleLine(line: string): boolean {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const first = line[i];
  if (first === '=') {
    let j = i;
    while (line[j] === '=') j++;
    return trimEndBlank(line, line.length, j) === j;
  }
  if (first !== '-' && first !== '*' && first !== '_') return false;
  let marks = 0;
  for (let j = i; j < line.length; j++) {
    if (line[j] === first) marks++;
    else if (!isBlank(line.charCodeAt(j))) return false;
  }
  return marks >= 3;
}

/** The text of an ATX heading line (`## Title ##`), or null when the line is not a heading. */
function headingText(line: string): string | null {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  let h = i;
  while (line[h] === '#') h++;
  if (h - i < 1 || h - i > 6) return null;
  if (h === line.length) return '';
  const w = skipBlank(line, h);
  if (w === h) return null; // `#general`, `#123`
  const end = trimEndBlank(line, line.length, w);
  let k = end;
  while (k > w && line[k - 1] === '#') k--;
  if (k === end || k === w) return line.slice(w, end); // no closing sequence, or nothing but hashes (that is the text)
  const m = trimEndBlank(line, k, w);
  return m < k ? line.slice(w, m) : line.slice(w, end); // `C#` keeps its hash
}

/** `| a | b |` to `a  b`. */
function tableRow(line: string): string {
  let start = skipBlank(line, 0);
  if (line[start] !== '|') return line;
  start = skipBlank(line, start + 1);
  let end = line.length;
  const trimmed = trimEndBlank(line, end, start);
  if (trimmed > start && line[trimmed - 1] === '|') end = trimEndBlank(line, trimmed - 1, start); // a closing pipe takes its blanks along
  const cells: string[] = [];
  let at = start;
  for (;;) {
    const bar = line.indexOf('|', at);
    const cellEnd = bar === -1 || bar >= end ? end : bar;
    cells.push(line.slice(at, cellEnd));
    if (cellEnd >= end) break;
    at = skipBlank(line, cellEnd + 1);
    // the blanks before the next pipe belong to the pipe
    const last = cells.length - 1;
    cells[last] = (cells[last] as string).slice(0, trimEndBlank(cells[last] as string, (cells[last] as string).length));
  }
  return cells.join('  ');
}

/** A hard line break (two blanks, or a backslash) and trailing blanks go. */
function tidyEnd(line: string): string {
  const end = line.length;
  const blanks = trimEndBlank(line, end);
  let cut = end;
  if (end - blanks >= 2) cut = blanks;
  else if (line.charCodeAt(end - 1) === 92) cut = end - 1;
  return line.slice(0, trimEndBlank(line, cut));
}

/** The plain text of one line, or null when the line is only markup and disappears. */
function blockLine(raw: string): string | null {
  if (raw === '') return raw;
  if (isTableRule(raw) || isRuleLine(raw) || REF_DEFINITION.test(raw)) return null;
  let line = raw.replace(QUOTE, '');
  const heading = headingText(line);
  if (heading !== null) line = heading;
  line = line.replace(LIST_ITEM, '$1');
  line = tableRow(line);
  return tidyEnd(line);
}

// ---- entity refs -------------------------------------------------------------------------------------------------

/** `[[thread:..]]`, `[[file:..]]`, `[[page:..]]`, `[[task:..]]` (not escaped) are held verbatim. */
function holdEntityRefs(text: string, hold: (s: string) => string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while ((i = text.indexOf('[[', i)) !== -1) {
    const kind = text.charCodeAt(i - 1) === 92 ? undefined : ENTITY_KINDS.find((k) => text.startsWith(k, i + 2));
    if (kind) {
      const nameStart = i + 2 + kind.length;
      let k = nameStart;
      for (; k < text.length && k - nameStart <= ENTITY_MAX; k++) {
        const c = text.charCodeAt(k);
        if (c === 91 || c === 93 || c === 10 || c === 124) break; // [ ] \n |
      }
      if (k > nameStart && k - nameStart <= ENTITY_MAX && text.startsWith(']]', k)) {
        out += text.slice(last, i) + hold(text.slice(i, k + 2));
        last = i = k + 2;
        continue;
      }
    }
    i++;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---- links and images --------------------------------------------------------------------------------------------

interface BracketTables {
  /** First `]` at or after the index on the same line, or -1. */
  nextClose: Int32Array;
  /** Where a link destination that starts at the index ends: `(?:[^()\s]|\([^()\s]*\))*`, deterministic. */
  destEnd: Int32Array;
}

function bracketTables(text: string): BracketTables {
  const n = text.length;
  const nextClose = new Int32Array(n + 1).fill(-1);
  const stop = new Int32Array(n + 1); // first `(`, `)` or whitespace at or after the index
  const destEnd = new Int32Array(n + 1);
  stop[n] = n;
  destEnd[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    nextClose[i] = c === 93 ? i : c === 10 ? -1 : (nextClose[i + 1] as number);
    const paren = c === 40 || c === 41;
    stop[i] = paren || isSpaceAt(text, i) ? i : (stop[i + 1] as number);
    if (c === 40) {
      const close = stop[i + 1] as number;
      destEnd[i] = close < n && text.charCodeAt(close) === 41 ? (destEnd[close + 1] as number) : i;
    } else {
      destEnd[i] = paren || isSpaceAt(text, i) ? i : (destEnd[i + 1] as number);
    }
  }
  return { nextClose, destEnd };
}

/**
 * `![alt](dest "title")` (mode image), `[text](dest "title")` (link) and `[text][ref]` / `![alt][ref]` (ref), replaced by
 * their label. A label runs to the first `]` on its line. What follows the `]` depends only on the `]`, so it is worked out
 * once per `]` however many `[` lead to it.
 */
function replaceBrackets(text: string, mode: 'image' | 'link' | 'ref'): string {
  if (!text.includes('[')) return text;
  const n = text.length;
  const { nextClose, destEnd } = bracketTables(text);
  const titleMemo = new Map<number, number>();
  const tailMemo = new Map<number, number>();

  /** After a destination: an optional `"title"` or `'title'` after blanks, then blanks and `)`. Returns the end or -1. */
  const closeLink = (e: number): number => {
    const known = titleMemo.get(e);
    if (known !== undefined) return known;
    let result = -1;
    let k = e;
    while (k < n && isSpaceAt(text, k)) k++;
    const quote = text[k];
    if (k > e && (quote === '"' || quote === "'")) {
      let q = k + 1;
      while (q < n && text[q] !== quote && text[q] !== '\n') q++;
      if (text[q] === quote) {
        let after = q + 1;
        while (after < n && isSpaceAt(text, after)) after++;
        if (text[after] === ')') result = after + 1;
      }
    }
    if (result === -1 && text[k] === ')') result = k + 1;
    titleMemo.set(e, result);
    return result;
  };

  /** What follows the `]` at `j`, or -1: `(...)` for links and images, `[...]` for references. */
  const tail = (j: number): number => {
    const known = tailMemo.get(j);
    if (known !== undefined) return known;
    let result = -1;
    if (mode === 'ref') {
      if (text[j + 1] === '[') {
        const close = nextClose[j + 2] as number;
        if (close !== -1) result = close + 1;
      }
    } else if (text[j + 1] === '(') {
      result = closeLink(destEnd[j + 2] as number);
    }
    tailMemo.set(j, result);
    return result;
  };

  let out = '';
  let last = 0;
  let i = 0;
  while (i < n) {
    const at = text.indexOf('[', i);
    if (at === -1) break;
    const banged = at - 1 >= i && text[at - 1] === '!';
    const j = nextClose[at + 1] as number;
    const labelOk = j !== -1 && j - (at + 1) >= (mode === 'image' ? 0 : 1);
    const end = labelOk && (mode !== 'image' || banged) ? tail(j) : -1;
    if (end === -1) {
      i = at + 1;
      continue;
    }
    const start = mode !== 'link' && banged ? at - 1 : at;
    out += text.slice(last, start) + text.slice(at + 1, j);
    last = i = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---- angle brackets ----------------------------------------------------------------------------------------------

/** `<https://x>` and `<a@b.c>` lose their brackets. */
function replaceAutolinks(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while ((i = text.indexOf('<', i)) !== -1) {
    let r = i + 1;
    while (r < text.length) {
      const c = text.charCodeAt(r);
      if (c === 60 || c === 62 || isSpaceAt(text, r)) break; // the run ends at the next `<`, so runs never overlap
      r++;
    }
    if (r < text.length && text.charCodeAt(r) === 62 && r > i + 1) {
      const body = text.slice(i + 1, r);
      if (AUTOLINK_SCHEME.test(body) || AUTOLINK_EMAIL.test(body)) {
        out += text.slice(last, i) + body;
        last = i = r + 1;
        continue;
      }
    }
    i++;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** A handful of inline html tags (`<b>`, `</span class="x">`, `<br/>`) are dropped. */
function dropHtmlTags(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while ((i = text.indexOf('<', i)) !== -1) {
    let k = i + 1;
    if (text[k] === '/') k++;
    const nameStart = k;
    for (; k < text.length; k++) {
      const c = text.charCodeAt(k) | 32; // ASCII letters and digits only
      if (!((c >= 97 && c <= 122) || (text.charCodeAt(k) >= 48 && text.charCodeAt(k) <= 57))) break;
    }
    let end = -1;
    if (HTML_TAGS.has(text.slice(nameStart, k).toLowerCase())) {
      if (k < text.length && isSpaceAt(text, k)) {
        let m = k + 1;
        while (m < text.length && text[m] !== '<' && text[m] !== '>') m++;
        if (text[m] === '>') end = m + 1;
      } else if (text[k] === '>') end = k + 1;
      else if (text[k] === '/' && text[k + 1] === '>') end = k + 2;
    }
    if (end === -1) {
      i++;
      continue;
    }
    out += text.slice(last, i);
    last = i = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---- emphasis and strike -----------------------------------------------------------------------------------------

/**
 * `*a*`, `**a**`, `***a***` (and the same with `_`): an opener of one to three marks that starts a word and is followed by a
 * non-blank, closed by the nearest run of exactly as many marks that follows a non-blank and does not run into a word.
 * Closers are found in one scan; openers then take the first closer past them, so the work is linear.
 */
function replaceEmphasis(text: string, mark: '*' | '_'): string {
  if (!text.includes(mark)) return text;
  const n = text.length;
  const code = mark.charCodeAt(0);
  const closers: number[][] = [[], [], [], []];
  const runs: Array<[number, number]> = [];
  for (let i = text.indexOf(mark); i !== -1 && i < n; ) {
    let j = i;
    while (j < n && text.charCodeAt(j) === code) j++;
    runs.push([i, j]);
    if (j - i <= 3 && i > 0 && !isSpaceAt(text, i - 1) && (j >= n || !alnumAt(text, j))) (closers[j - i] as number[]).push(i);
    i = text.indexOf(mark, j);
  }
  let out = '';
  let last = 0;
  const pointer = [0, 0, 0, 0];
  let reach = 0; // runs before `reach` lie inside a replaced span
  for (const [i, j] of runs) {
    const length = j - i;
    if (i < reach || length > 3 || j >= n || isSpaceAt(text, j) || alnumBefore(text, i)) continue;
    const list = closers[length] as number[];
    let p = pointer[length] as number;
    while (p < list.length && (list[p] as number) <= j) p++;
    pointer[length] = p;
    if (p >= list.length) continue;
    const close = list[p] as number;
    out += text.slice(last, i) + text.slice(j, close);
    last = reach = close + length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** `~~a~~`: the nearest `~~` that follows a non-blank closes it. */
function replaceStrike(text: string): string {
  if (!text.includes('~~')) return text;
  const closers: number[] = [];
  for (let k = text.indexOf('~~'); k !== -1; k = text.indexOf('~~', k + 1)) {
    if (k > 0 && !isSpaceAt(text, k - 1)) closers.push(k);
  }
  let out = '';
  let last = 0;
  let p = 0;
  let i = 0;
  while ((i = text.indexOf('~~', i)) !== -1) {
    if (i + 2 < text.length && !isSpaceAt(text, i + 2)) {
      while (p < closers.length && (closers[p] as number) < i + 3) p++;
      if (p >= closers.length) break; // nothing closes from here on
      const close = closers[p] as number;
      out += text.slice(last, i) + text.slice(i + 2, close);
      last = i = close + 2;
      continue;
    }
    i++;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---- entry point -------------------------------------------------------------------------------------------------

/**
 * Markdown to the text a reader sees, for `body_plain` and search: markers and link targets are dropped, link and image
 * text stays, code (spans and fences) is kept verbatim, `@mentions`, `#channels` and `[[entity]]` refs (`[[thread:..]]`,
 * `[[file:..]]`, `[[page:..]]`, `[[task:..]]`; a bare `[[text]]` is just text) are left as typed. Line breaks are kept.
 * Not a renderer: it covers what a chat composer produces (headings, emphasis, strike, links, images, quotes, lists, tables,
 * rules, fences, a few inline HTML tags). Never throws, and runs in time linear in the input.
 */
export function toPlainText(markdown: string): string {
  const held: string[] = [];
  const hold = (text: string): string => `${OPEN}${held.push(text) - 1}${CLOSE}`;

  // Our placeholder characters are private use; a body that already holds them cannot collide.
  let text = markdown.replace(/\r\n?/g, '\n').replaceAll(OPEN, '').replaceAll(CLOSE, '');

  // 1. Code first, so nothing below touches it.
  let out = '';
  let at = 0;
  for (const code of findCodeRanges(text)) {
    out += text.slice(at, code.start) + hold(text.slice(code.contentStart, code.contentEnd));
    at = code.end;
  }
  text = out + text.slice(at);

  // 2. Things that must survive verbatim and must not be read as markdown: entity refs and escaped punctuation.
  text = holdEntityRefs(text, hold).replace(ESCAPABLE, (_m, ch: string) => hold(ch));

  // 3. Block markers, line by line.
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = blockLine(raw);
    if (line !== null) lines.push(line);
  }
  text = lines.join('\n');

  // 4. Inline markup.
  text = replaceBrackets(text, 'image');
  text = replaceBrackets(text, 'link');
  text = replaceBrackets(text, 'ref');
  text = dropHtmlTags(replaceAutolinks(text));
  for (let pass = 0; pass < 3; pass++) text = replaceStrike(replaceEmphasis(replaceEmphasis(text, '*'), '_'));

  // 5. Put code and escapes back; tidy blank lines.
  const restore = (s: string): string => (held.length === 0 ? s : s.replace(HOLD, (_m, i: string) => restore(held[Number(i)] ?? '')));
  return restore(text).replace(/\n{3,}/g, '\n\n').trim();
}
