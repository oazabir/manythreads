/** Where markdown code lives. Pure string scanning, no dependencies: runs in the browser and on the server. */

export interface CodeRange {
  kind: 'fence' | 'span';
  /** Whole construct including delimiters, `end` exclusive. */
  start: number;
  end: number;
  /** The code itself, without delimiters (and, for a fence, without the fence lines). */
  contentStart: number;
  contentEnd: number;
}

const FENCE_OPEN = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})([^\n]*)$/;

function findFences(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    const open = FENCE_OPEN.exec(line);
    const fence = open?.[2];
    // A backtick fence's info string cannot contain a backtick (that is an inline span like ```a```).
    if (open && fence && !(fence[0] === '`' && (open[3] ?? '').includes('`'))) {
      const char = fence[0] as string;
      const closer = new RegExp(`^[ \\t>]*${char === '`' ? '`' : '~'}{${fence.length},}[ \\t\\r]*$`);
      let scan = nl === -1 ? text.length : nl + 1;
      let contentEnd = text.length;
      let end = text.length;
      while (scan <= text.length && nl !== -1) {
        const next = text.indexOf('\n', scan);
        const endOfLine = next === -1 ? text.length : next;
        if (closer.test(text.slice(scan, endOfLine))) {
          contentEnd = Math.max(scan - 1, nl + 1);
          end = endOfLine;
          break;
        }
        if (next === -1) break;
        scan = next + 1;
      }
      const contentStart = nl === -1 ? text.length : nl + 1;
      ranges.push({ kind: 'fence', start: pos, end, contentStart, contentEnd: Math.max(contentEnd, contentStart) });
      if (end >= text.length) break;
      pos = end + 1;
      continue;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return ranges;
}

const isEscaped = (text: string, index: number): boolean => {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
};

/** Inline code spans in `text[from, to)`: a backtick run closed by the next run of exactly the same length, within one paragraph. */
function findInlineCode(text: string, from: number, to: number, out: CodeRange[]): void {
  let i = from;
  while (i < to) {
    if (text[i] !== '`' || isEscaped(text, i)) {
      i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < to && text[runEnd] === '`') runEnd++;
    const length = runEnd - i;
    let search = runEnd;
    let close = -1;
    while (search < to) {
      const at = text.indexOf('`', search);
      if (at === -1 || at >= to) break;
      let end = at;
      while (end < to && text[end] === '`') end++;
      if (end - at === length) {
        close = at;
        break;
      }
      search = end;
    }
    if (close === -1 || /\n[ \t]*\n/.test(text.slice(runEnd, close))) {
      i = runEnd; // literal backticks
      continue;
    }
    out.push({ kind: 'span', start: i, end: close + length, contentStart: runEnd, contentEnd: close });
    i = close + length;
  }
}

/** Fenced blocks and inline spans, sorted and non-overlapping. An unclosed fence runs to the end of the text. */
export function findCodeRanges(text: string): CodeRange[] {
  const fences = findFences(text);
  const all: CodeRange[] = [...fences];
  let from = 0;
  for (const fence of [...fences, { start: text.length, end: text.length }]) {
    findInlineCode(text, from, fence.start, all);
    from = fence.end;
  }
  return all.sort((a, b) => a.start - b.start);
}
