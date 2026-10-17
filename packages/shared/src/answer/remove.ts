import { SNIPPET, assembleBlock, headOf } from './boundary.ts';
import { holdsMarker } from './markers.ts';
import { continuationLength, prefixLength, segmentBlock } from './segment.ts';

/** What `removeClaims` did. */
export interface ClaimRemoval {
  /** The answer's text after the removal; the same string, untouched, when nothing was removed. */
  body: string;
  /** How many sentences (or whole blocks) were taken out. */
  sentences: number;
  /** The words that were taken out, one entry per sentence, trimmed and cut at 400 characters: what the sharer's preview shows. */
  removed: string[];
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
