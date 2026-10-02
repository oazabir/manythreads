import type { DiffHunk, DiffLine, FileDiff } from './model';

/*
 * A line diff for the mock store and for the History panel's own use (the server answers with hunks; this builds the same shape from two
 * texts). Longest common subsequence over lines, three lines of context, bounded: two files whose product of lines is above the cap
 * are shown as "all deleted, all added" instead of stalling the page.
 */

const CONTEXT = 3;
const CAP = 4_000_000;

const linesOf = (text: string | null): string[] => {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

export function lineDiff(before: string | null, after: string | null): FileDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  const ops: Array<{ type: DiffLine['type']; text: string }> = [];
  if (a.length * b.length > CAP) {
    for (const t of a) ops.push({ type: 'del', text: t });
    for (const t of b) ops.push({ type: 'add', text: t });
  } else {
    // lcs[i][j]: length of the common subsequence of a[i..] and b[j..]
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * w + j] = a[i] === b[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ type: 'context', text: a[i] as string });
        i++;
        j++;
      } else if (i < a.length && (j === b.length || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
        // what went out is listed before what came in, as a unified diff does
        ops.push({ type: 'del', text: a[i] as string });
        i++;
      } else {
        ops.push({ type: 'add', text: b[j] as string });
        j++;
      }
    }
  }

  const numbered: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    if (op.type === 'context') numbered.push({ ...op, oldLine: oldLine++, newLine: newLine++ });
    else if (op.type === 'add') numbered.push({ ...op, oldLine: null, newLine: newLine++ });
    else numbered.push({ ...op, oldLine: oldLine++, newLine: null });
  }
  const additions = numbered.filter((l) => l.type === 'add').length;
  const deletions = numbered.filter((l) => l.type === 'del').length;

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < numbered.length) {
    while (i < numbered.length && numbered[i]?.type === 'context') i++;
    if (i >= numbered.length) break;
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    let lastChange = i;
    while (end < numbered.length) {
      if (numbered[end]?.type !== 'context') lastChange = end;
      else if (end - lastChange > CONTEXT * 2) break;
      end++;
    }
    const stop = Math.min(numbered.length, lastChange + CONTEXT + 1);
    const lines = numbered.slice(start, stop);
    const oldFirst = lines.find((l) => l.oldLine !== null)?.oldLine ?? 0;
    const newFirst = lines.find((l) => l.newLine !== null)?.newLine ?? 0;
    const oldLines = lines.filter((l) => l.oldLine !== null).length;
    const newLines = lines.filter((l) => l.newLine !== null).length;
    hunks.push({ header: `@@ -${oldFirst},${oldLines} +${newFirst},${newLines} @@`, lines });
    i = stop;
  }
  const status = before === null && after !== null ? 'added' : before !== null && after === null ? 'deleted' : additions + deletions === 0 ? 'unchanged' : 'modified';
  return { status, binary: false, additions, deletions, hunks, truncated: false };
}
