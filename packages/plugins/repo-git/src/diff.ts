import type { RepoDiffHunk, RepoDiffLine } from '@manythreads/shared';

// A unified patch of ONE file (`git diff a b -- path`) as hunks. Linear: one pass over the lines, each line judged once, no regular expression with
// a nested quantifier (the patch is text the repository's authors wrote).

const HUNK = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@ ?([\s\S]{0,500})$/;

export interface ParsedPatch {
  hunks: RepoDiffHunk[];
  binary: boolean;
  additions: number;
  deletions: number;
}

export function parseUnifiedPatch(patch: string): ParsedPatch {
  const hunks: RepoDiffHunk[] = [];
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let current: RepoDiffHunk | null = null;
  let oldAt = 0;
  let newAt = 0;
  // Lines left in the current hunk on each side: a `-`-looking line after the counts are spent is the next file header, not content.
  let oldLeft = 0;
  let newLeft = 0;
  let start = 0;
  const len = patch.length;
  while (start < len) {
    let end = patch.indexOf('\n', start);
    if (end < 0) end = len;
    const line = patch.slice(start, end);
    start = end + 1;
    if (current !== null && (oldLeft > 0 || newLeft > 0)) {
      const c = line.charAt(0);
      if (c === '\\') continue; // "\ No newline at end of file"
      let item: RepoDiffLine | null = null;
      if (c === '+' && newLeft > 0) {
        item = { type: 'add', text: line.slice(1), oldLine: null, newLine: newAt };
        newAt += 1;
        newLeft -= 1;
        additions += 1;
      } else if (c === '-' && oldLeft > 0) {
        item = { type: 'del', text: line.slice(1), oldLine: oldAt, newLine: null };
        oldAt += 1;
        oldLeft -= 1;
        deletions += 1;
      } else if ((c === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        item = { type: 'context', text: line.slice(1), oldLine: oldAt, newLine: newAt };
        oldAt += 1;
        newAt += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      if (item) {
        current.lines.push(item);
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (!m) continue;
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      current = { oldStart, oldLines, newStart, newLines, header: (m[5] ?? '').trim(), lines: [] };
      hunks.push(current);
      oldAt = oldLines === 0 ? oldStart + 1 : oldStart;
      newAt = newLines === 0 ? newStart + 1 : newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
  }
  return { hunks, binary, additions, deletions };
}
