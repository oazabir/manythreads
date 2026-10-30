// A line diff of two texts, used for the "what would change" view of a proposal (P7-01) and by the Files history panel. Pure: no I/O.
// Longest common subsequence over lines, three lines of context, bounded: two files whose product of lines is above the cap are shown as
// "all deleted, all added" instead of stalling the caller.

export type DiffLineType = 'context' | 'add' | 'del';
export type DiffLineEntry = { type: DiffLineType; text: string; oldLine: number | null; newLine: number | null };
export type DiffHunkEntry = { header: string; lines: DiffLineEntry[] };
export type LineDiff = { additions: number; deletions: number; hunks: DiffHunkEntry[] };

const CONTEXT = 3;
const CAP = 4_000_000;

const linesOf = (text: string | null): string[] => {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** The change from `before` to `after` (`null` is "no file") as unified hunks. */
export function lineDiff(before: string | null, after: string | null): LineDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  const ops: Array<{ type: DiffLineType; text: string }> = [];
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

  const numbered: DiffLineEntry[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    if (op.type === 'context') numbered.push({ ...op, oldLine: oldLine++, newLine: newLine++ });
    else if (op.type === 'add') numbered.push({ ...op, oldLine: null, newLine: newLine++ });
    else numbered.push({ ...op, oldLine: oldLine++, newLine: null });
  }
  const additions = numbered.filter((l) => l.type === 'add').length;
  const deletions = numbered.filter((l) => l.type === 'del').length;

  const hunks: DiffHunkEntry[] = [];
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
  return { additions, deletions, hunks };
}

/** A unified diff as text (`--- a/…`, `+++ b/…`, hunks), which is what a proposal stores. A file that is new or gone shows `/dev/null` on that side. */
export function toUnifiedDiff(path: string, before: string | null, after: string | null): { text: string; additions: number; deletions: number } {
  const d = lineDiff(before, after);
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  for (const h of d.hunks) {
    out.push(h.header);
    for (const l of h.lines) out.push(`${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`);
  }
  return { text: out.join('\n'), additions: d.additions, deletions: d.deletions };
}

/** Reads the text `toUnifiedDiff` wrote back into hunks (the web app draws them). Lines that are not part of a hunk are skipped. */
export function parseUnifiedDiff(text: string): DiffHunkEntry[] {
  const hunks: DiffHunkEntry[] = [];
  let current: DiffHunkEntry | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!current) continue;
    const mark = raw[0];
    const body = raw.slice(1);
    if (mark === '+') current.lines.push({ type: 'add', text: body, oldLine: null, newLine: newLine++ });
    else if (mark === '-') current.lines.push({ type: 'del', text: body, oldLine: oldLine++, newLine: null });
    else if (mark === ' ') current.lines.push({ type: 'context', text: body, oldLine: oldLine++, newLine: newLine++ });
  }
  return hunks;
}
