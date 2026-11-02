// Task-list boxes (`- [ ] a`, `- [x] b`) read and changed in the source text, in one place: the chat, a card's description and a page all draw a box from a
// line of Markdown, and a tick has to change exactly that line. Pure and linear: one pass over the lines, one bounded match per line.
// A box is counted over the whole text, outside fenced code, in the order it appears (the first box is number 0).
// Lines are read the way the chat reads them: a carriage return alone, a carriage return with a newline and a newline each end a line, and the characters
// `cleanText` removes are ignored (they are left in the text that is returned).

import { UNSAFE_CHARS } from './clean.ts';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_ANY = /^\s*(`{3,}|~{3,})/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})\s*$/;
const FENCE_END_ANY = /^\s*(`{3,}|~{3,})\s*$/;
// What the message and card renderer reads as a box: a top-level bullet (up to three spaces), possibly inside up to two block quotes.
const BOX_FLAT = /^((?: {0,3}> ?){0,2} {0,3}[-*+] +\[)([ xX])(\] +)([\s\S]*)$/;
// What a page editor reads as a box: any depth of list nesting and quoting.
const BOX_NESTED = /^((?:\s*>)*\s*[-*+] +\[)([ xX])(\] +)([\s\S]*)$/;
const QUOTE_FLAT = /^(?: {0,3}> ?){1,2}/;
const QUOTE_NESTED = /^(?:\s*>\s?)+/;
const LINE_END = /(\r\n|\r|\n)/;

export interface TaskListOptions {
  /** Count boxes at any indentation (a page, edited as a document). Absent: only the top-level boxes the chat and a card draw. */
  nested?: boolean;
}

/** One box: its place among the boxes, its state, and the text after it. */
export interface TaskItem {
  nth: number;
  checked: boolean;
  text: string;
  /** The index of its line in the text. */
  line: number;
}

interface Found extends TaskItem {
  /** Where the character between the brackets is, in the line as written. */
  at: number;
}

/** The index in `written` of the character that sits at `cleanedAt` once the unsafe characters are taken out. */
function writtenIndex(written: string, cleanedAt: number): number {
  let seen = 0;
  for (let i = 0; i < written.length; i += 1) {
    if (written[i]!.replace(UNSAFE_CHARS, '') === '') continue;
    if (seen === cleanedAt) return i;
    seen += 1;
  }
  return written.length;
}

function scan(source: string, options: TaskListOptions, visit: (item: Found) => boolean): void {
  const parts = source.split(LINE_END); // text, separator, text, separator, ..., text
  const nested = options.nested === true;
  const box = nested ? BOX_NESTED : BOX_FLAT;
  const fenceStart = nested ? FENCE_ANY : FENCE;
  const fenceEnd = nested ? FENCE_END_ANY : FENCE_END;
  const quote = nested ? QUOTE_NESTED : QUOTE_FLAT;
  let seen = 0;
  // the fence we are inside: its marker, and whether it was opened inside a block quote (which then ends it when the quote ends)
  let fence: { marker: string; quoted: boolean } | null = null;
  for (let i = 0; i < parts.length; i += 2) {
    const written = parts[i] ?? '';
    const line = written.replace(UNSAFE_CHARS, '');
    const quotePrefix = quote.exec(line)?.[0] ?? '';
    if (fence !== null && fence.quoted && quotePrefix === '') fence = null;
    if (fence !== null) {
      const inner = fence.quoted ? line.slice(quotePrefix.length) : line;
      const end = fenceEnd.exec(inner)?.[1];
      if (end && end[0] === fence.marker[0] && end.length >= fence.marker.length) fence = null;
      continue;
    }
    const open = fenceStart.exec(line.slice(quotePrefix.length))?.[1];
    if (open) {
      fence = { marker: open, quoted: quotePrefix !== '' };
      continue;
    }
    const m = box.exec(line);
    if (!m) continue;
    const prefix = m[1] ?? '';
    const stop = visit({ nth: seen, checked: m[2] !== ' ', text: (m[4] ?? '').trimEnd(), line: i / 2, at: writtenIndex(written, prefix.length) });
    if (stop) return;
    seen += 1;
  }
}

/** The box with this number, or null when the text has fewer. */
export function taskItemAt(source: string, nth: number, options: TaskListOptions = {}): TaskItem | null {
  let found: TaskItem | null = null;
  scan(source, options, (b) => {
    if (b.nth !== nth) return false;
    found = { nth: b.nth, checked: b.checked, text: b.text, line: b.line };
    return true;
  });
  return found;
}

/** How many boxes the text has. */
export function countTaskItems(source: string, options: TaskListOptions = {}): number {
  let n = 0;
  scan(source, options, () => {
    n += 1;
    return false;
  });
  return n;
}

/**
 * The text with the box number `nth` set to `checked`; the text unchanged when there is no such box. Only the one character between the brackets changes, so
 * a person's tick is a one-character edit and the rest of the text keeps its bytes.
 */
export function setTaskChecked(source: string, nth: number, checked: boolean, options: TaskListOptions = {}): string {
  let out = source;
  scan(source, options, (b) => {
    if (b.nth !== nth) return false;
    const parts = source.split(LINE_END);
    const written = parts[b.line * 2] ?? '';
    parts[b.line * 2] = `${written.slice(0, b.at)}${checked ? 'x' : ' '}${written.slice(b.at + 1)}`;
    out = parts.join('');
    return true;
  });
  return out;
}

/**
 * A tick on a page, as a pure function: the box the editor counted as number `nth`, whose text is `text`, set to `checked`. Null when the text's own count
 * differs from the editor's (`boxes`), when box `nth` says something else than `text`, or when it already has that state: the caller then leaves the click to
 * the editor. `text` is compared on its words only (the editor shows marks and links, not their Markdown), by `itemMatches`.
 */
export function tickInPage(source: string, nth: number, checked: boolean, boxes: number, text: string): string | null {
  const opts = { nested: true } as const;
  // front matter is data, not page text: its lines are never boxes
  const head = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)?.[0] ?? '';
  const body = source.slice(head.length);
  if (countTaskItems(body, opts) !== boxes) return null;
  const item = taskItemAt(body, nth, opts);
  if (item === null || item.checked === checked || !itemMatches(item.text, text)) return null;
  return head + setTaskChecked(body, nth, checked, opts);
}

const words = (s: string): string => s.replace(/[`*_~\\[\]()<>]/g, '').replace(/\s+/g, ' ').trim();
/** Whether the Markdown of an item and the plain text an editor shows for it are the same words (marks, links and code quotes aside). */
export function itemMatches(markdown: string, shown: string): boolean {
  const a = words(markdown);
  const b = words(shown);
  return a === b || (b !== '' && a.startsWith(b)) || (a !== '' && b.startsWith(a));
}
