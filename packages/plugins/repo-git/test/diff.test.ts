import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { parseUnifiedPatch } from '../src/diff.ts';

// The unified patch of one file as hunks: line numbers on both sides, the "no newline" marker, a file header that looks like a change, hostile input.

const patch = [
  'diff --git a/pages/a.md b/pages/a.md',
  'index 1111111..2222222 100644',
  '--- a/pages/a.md',
  '+++ b/pages/a.md',
  '@@ -1,4 +1,5 @@ # Title',
  ' one',
  '-two',
  '+TWO',
  '+two and a half',
  ' three',
  ' four',
  '@@ -20 +21 @@',
  '-old',
  '+new',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parseUnifiedPatch', () => {
  it('reads hunks with line numbers on each side', () => {
    const p = parseUnifiedPatch(patch);
    expect(p.hunks).toHaveLength(2);
    expect(p.additions).toBe(3);
    expect(p.deletions).toBe(2);
    expect(p.binary).toBe(false);
    expect(p.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, header: '# Title' });
    expect(p.hunks[0]!.lines.map((l) => `${l.type}:${l.oldLine ?? '-'}:${l.newLine ?? '-'}:${l.text}`)).toEqual([
      'context:1:1:one',
      'del:2:-:two',
      'add:-:2:TWO',
      'add:-:3:two and a half',
      'context:3:4:three',
      'context:4:5:four',
    ]);
    expect(p.hunks[1]).toMatchObject({ oldStart: 20, oldLines: 1, newStart: 21, newLines: 1 });
    expect(p.hunks[1]!.lines).toHaveLength(2);
  });

  it('a created file has an old side of zero lines; a deleted one a new side of zero lines', () => {
    const created = parseUnifiedPatch('--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(created.hunks[0]!.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([['add', null, 1], ['add', null, 2]]);
    const removed = parseUnifiedPatch('--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n');
    expect(removed.hunks[0]!.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([['del', 1, null], ['del', 2, null]]);
    expect(removed.deletions).toBe(2);
  });

  it('a removed line that starts with "--" is content, not a header', () => {
    const p = parseUnifiedPatch('@@ -1,2 +1 @@\n--- a rule\n keep\n');
    expect(p.hunks[0]!.lines[0]).toMatchObject({ type: 'del', text: '-- a rule' });
  });

  it('flags a binary file and returns no hunks', () => {
    const p = parseUnifiedPatch('diff --git a/x b/x\nindex 1..2\nBinary files a/x and b/x differ\n');
    expect(p).toMatchObject({ binary: true, hunks: [], additions: 0, deletions: 0 });
  });

  it('survives a truncated patch and garbage', () => {
    expect(parseUnifiedPatch('@@ -1,50 +1,50 @@\n-a\n+b\n').hunks[0]!.lines).toHaveLength(2);
    expect(parseUnifiedPatch('').hunks).toEqual([]);
    expect(parseUnifiedPatch('@@ nonsense @@\n+x\n').hunks).toEqual([]);
  });

  it('is linear on hostile input (a 5 MB patch of hunk headers and long lines)', () => {
    const patch = (hunks: number): string => {
      const lines: string[] = [];
      for (let i = 0; i < hunks; i += 1) lines.push(`@@ -${i},1 +${i},1 @@ ${'x'.repeat(200)}`, `-${'-'.repeat(100)}`, `+${'+'.repeat(100)}`);
      return lines.join('\n');
    };
    expect(parseUnifiedPatch(patch(20_000)).hunks).toHaveLength(20_000);
    // a patch four times as large costs about four times as much (a quadratic parser sixteen), under a ceiling a busy machine does not reach
    expectLinear(patch, (big) => parseUnifiedPatch(big), { n: 5_000, ceilingMs: 2_000, label: 'a patch of hunk headers' });
    expectLinear(
      (n) => [`@@ -1 +1 @@ ${'@'.repeat(n)}`, `@@ -1,1 +1,1 @@\n${' '.repeat(n)}`],
      (inputs) => inputs.forEach((input) => parseUnifiedPatch(input)),
      { n: 500_000, label: 'one very long line' },
    );
  });
});
