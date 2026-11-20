/*
 * The text edits behind the composer's formatting buttons (PLAN P14-02). Each takes the text and the selection (`a` to `b`) and answers the
 * new text with the selection to restore, so the textarea does nothing but apply the answer. They write the Markdown `markdown.ts` reads:
 * `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, fenced blocks with a language, `> quote`, `- ` and `1. ` lists, `[text](address)`.
 */

export type Edit = { text: string; from: number; to: number };

/** The languages offered for a code block: the label people see and the word after the opening fence. */
export const CODE_LANGUAGES: ReadonlyArray<{ label: string; lang: string }> = [
  { label: 'Plain text', lang: '' },
  { label: 'TypeScript', lang: 'ts' },
  { label: 'JavaScript', lang: 'js' },
  { label: 'Python', lang: 'python' },
  { label: 'Shell', lang: 'bash' },
  { label: 'JSON', lang: 'json' },
  { label: 'YAML', lang: 'yaml' },
  { label: 'SQL', lang: 'sql' },
  { label: 'Go', lang: 'go' },
  { label: 'Rust', lang: 'rust' },
  { label: 'Diff', lang: 'diff' },
];

/**
 * Wraps the selection in a pair of marks, or takes the marks off when the selection is already wrapped in them (inside the selection, or just
 * around it). With nothing selected it writes `fallback` between the marks and selects it, so typing replaces it.
 */
export function wrapSelection(text: string, a: number, b: number, before: string, after: string, fallback: string): Edit {
  const chosen = text.slice(a, b);
  // A one-character mark (`*`, `` ` ``) that is half of a doubled one (`**`) is not this mark: italic must not take a star off bold text.
  const single = before.length === 1 && after.length === 1;
  const doubledAt = (i: number): boolean => single && (text[i] === before || text[i] === after);
  if (chosen.length >= before.length + after.length && chosen.startsWith(before) && chosen.endsWith(after)) {
    const inner = chosen.slice(before.length, chosen.length - after.length);
    // `**a** and **b**` starts and ends with the mark but is two spans: taking the outer marks off would break both
    if (!inner.includes(before) && !inner.includes(after)) return { text: text.slice(0, a) + inner + text.slice(b), from: a, to: a + inner.length };
  }
  if (
    a >= before.length &&
    text.slice(a - before.length, a) === before &&
    text.slice(b, b + after.length) === after &&
    !doubledAt(a - before.length - 1) &&
    !doubledAt(b + after.length)
  ) {
    return { text: text.slice(0, a - before.length) + chosen + text.slice(b + after.length), from: a - before.length, to: a - before.length + chosen.length };
  }
  const inner = chosen || fallback;
  return { text: text.slice(0, a) + before + inner + after + text.slice(b), from: a + before.length, to: a + before.length + inner.length };
}

/** Inline code for a selection on one line, a fenced block for anything longer; `lang` goes after the opening fence. */
export function codeSpan(text: string, a: number, b: number): Edit {
  return text.slice(a, b).includes('\n') ? codeBlock(text, a, b, '') : wrapSelection(text, a, b, '`', '`', 'code');
}

/** A fenced code block around the selected lines (or an empty one), with the language after the opening fence. */
export function codeBlock(text: string, a: number, b: number, lang: string): Edit {
  const chosen = text.slice(a, b);
  const lead = a > 0 && text[a - 1] !== '\n' ? '\n' : '';
  const open = `${lead}\`\`\`${lang}\n`;
  const body = chosen || 'code';
  const tail = '\n```';
  const rest = b < text.length && text[b] !== '\n' ? '\n' : '';
  const next = text.slice(0, a) + open + body + tail + rest + text.slice(b);
  return { text: next, from: a + open.length, to: a + open.length + body.length };
}

export type LineKind = 'bullet' | 'number' | 'quote';

const LINE_MARK: Readonly<Record<LineKind, RegExp>> = { bullet: /^[-*] /, number: /^\d+\. /, quote: /^> ?/ };

/** The marks a line kind writes at the start of line `i` (counting from 0). */
const mark = (kind: LineKind, i: number): string => (kind === 'bullet' ? '- ' : kind === 'number' ? `${i + 1}. ` : '> ');

/**
 * Puts a list or quote mark at the start of every line the selection touches, or takes the marks off when every one of those lines has it.
 * Numbered lines are numbered from 1. On an empty box it writes just the first mark, ready to type after.
 */
export function prefixLines(text: string, a: number, b: number, kind: LineKind): Edit {
  // `lastIndexOf` with a negative start still looks at index 0, so a caret at 0 is its own case; a selection that ends just after a line break
  // (a triple click, Shift+Down) does not reach the next line
  const start = a === 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1;
  const endAt = text.indexOf('\n', b > a && text[b - 1] === '\n' ? b - 1 : b);
  const end = endAt < 0 ? text.length : endAt;
  const lines = text.slice(start, end).split('\n');
  const re = LINE_MARK[kind];
  const all = lines.every((l) => re.test(l));
  const next = lines.map((l, i) => (all ? l.replace(re, '') : `${mark(kind, i)}${l.replace(LINE_MARK.bullet, '').replace(LINE_MARK.number, '').replace(LINE_MARK.quote, '')}`));
  const block = next.join('\n');
  const out = text.slice(0, start) + block + text.slice(end);
  const caret = start + block.length;
  return { text: out, from: lines.length === 1 && lines[0] === '' ? caret : start, to: caret };
}

const ADDRESS = /^(https?:\/\/|mailto:|\/)\S+$/i;

/**
 * A link. A selected address becomes the target of `[link](address)` with the word "link" selected for typing; any other selection becomes the
 * text, and the address placeholder is selected; with nothing selected both placeholders are written. An already linked `[text](address)`
 * selection is turned back into its text.
 */
export function linkSelection(text: string, a: number, b: number): Edit {
  const chosen = text.slice(a, b);
  const linked = /^\[([^\]\n]*)\]\(([^)\n]*)\)$/.exec(chosen);
  if (linked) {
    const label = linked[1] ?? '';
    return { text: text.slice(0, a) + label + text.slice(b), from: a, to: a + label.length };
  }
  if (ADDRESS.test(chosen.trim())) {
    const label = 'link';
    return { text: `${text.slice(0, a)}[${label}](${chosen.trim()})${text.slice(b)}`, from: a + 1, to: a + 1 + label.length };
  }
  const label = chosen || 'link text';
  const address = 'https://';
  const at = a + label.length + 3; // after `[label](`
  return { text: `${text.slice(0, a)}[${label}](${address})${text.slice(b)}`, from: at, to: at + address.length };
}

/** Writes `piece` over the selection, caret after it (an emoji, a mention). */
export function insertText(text: string, a: number, b: number, piece: string): Edit {
  const at = a + piece.length;
  return { text: text.slice(0, a) + piece + text.slice(b), from: at, to: at };
}

/** What Enter does in the message box: send, leave the key to the browser (a plain new line), or write `edit`. */
/** `replace` says the same change as `edit` as one replacement of the text between `start` and `end`, so the box can make it through the browser (`insertText`) and Ctrl+Z undoes it. */
export type EnterAction = { do: 'send' } | { do: 'default' } | { do: 'edit'; edit: Edit; replace: { start: number; end: number; insert: string } };

export type EnterKeys = { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };

/** A list line: its indent, its mark (`-`, `*`, `+`, `1.`, `1)`), an optional task box, and the words after them. */
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,3}[.)])( +)(\[[ xX]\] +)?(.*)$/; // up to three digits: "2024. was good" is a sentence, not item 2024
/** A line that opens or closes a fenced code block. */
const FENCE = /^[ \t]*(```|~~~)/;
/** A line that opens and closes a fence on itself (```npm i```): no block stays open after it. */
const ONE_LINE_FENCE = /^[ \t]*(```|~~~).*\1[ \t]*$/;

/** Whether `caret` sits inside a fenced code block that is still open. A ``` block is closed only by ``` and a ~~~ block only by ~~~; a one-line fence opens nothing. */
export function insideCodeBlock(text: string, caret: number): boolean {
  let open: string | null = null;
  for (const line of text.slice(0, caret).split('\n')) {
    const m = FENCE.exec(line);
    if (!m) continue;
    const kind = m[1] ?? '```';
    if (open === null) {
      if (!(ONE_LINE_FENCE.test(line) && line.trim().length > kind.length * 2)) open = kind;
    } else if (kind === open) open = null;
  }
  return open !== null;
}

/**
 * Enter in the message box (P34-03, finding 18). Ctrl or Cmd with Enter always sends. Shift+Enter (and Alt+Enter) is the browser's own new line. A plain
 * Enter continues what is being written instead of sending: inside a fenced code block it writes a new line, and in a list item it starts the next item
 * (`- `, `* `, the next number, an empty task box) at the same indent; Enter on an item with nothing after its mark ends the list (the mark goes, the
 * message stays). Anywhere else Enter sends, as it always did.
 */
export function enterKey(text: string, a: number, b: number, keys: EnterKeys): EnterAction {
  if (keys.ctrl || keys.meta) return keys.alt ? { do: 'default' } : { do: 'send' };
  if (keys.shift || keys.alt) return { do: 'default' };
  if (insideCodeBlock(text, a)) return { do: 'default' }; // the browser's own new line: Ctrl+Z undoes it
  const start = a === 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1;
  const endAt = text.indexOf('\n', a);
  const end = endAt < 0 ? text.length : endAt;
  const m = LIST_LINE.exec(text.slice(start, end));
  if (!m) return { do: 'send' };
  const [, indent = '', marker = '-', gap = ' ', box = '', words = ''] = m;
  const markEnd = start + indent.length + marker.length + gap.length + box.length;
  // the caret before the end of the mark (at the start of the line, say): a plain new line, the list is left as it is
  if (a < markEnd) return { do: 'default' };
  if (words.trim() === '' && b <= end) {
    // an empty item ends the list: its mark goes and the caret stays on the now empty line
    const out = text.slice(0, start) + text.slice(end);
    return { do: 'edit', edit: { text: out, from: start, to: start }, replace: { start, end, insert: '' } };
  }
  const num = /^(\d+)([.)])$/.exec(marker);
  const nextMark = num ? `${String(Number(num[1]) + 1)}${num[2] ?? '.'}` : marker;
  const insert = `\n${indent}${nextMark}${gap}${box ? '[ ] ' : ''}`;
  return { do: 'edit', edit: insertText(text, a, b, insert), replace: { start: a, end: b, insert } };
}

/** The tallest the message box grows before it scrolls, in px (a resting box is two lines, 46 px). Same number as `.cinput textarea` in channels.css. */
export const COMPOSER_MAX_HEIGHT = 376;
