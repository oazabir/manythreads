import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/screens/files/diff';
import { diffBlocks } from '../src/screens/files/RenderedDiff';
import { dayTime } from '../src/screens/files/HistoryPanel';
import { filesHref } from '../src/screens/files/paths';
import { acceptsUploads, baseName, matchesSource, matchesType, nameProblem, parentOf, sortRows, type FileRow } from '../src/screens/files/model';

const row = (over: Partial<FileRow> & { path: string }): FileRow => ({
  name: baseName(over.path), kind: 'file', store: 'git', size: 1, mime: null, modifiedAt: null, by: null, where: null,
  readOnly: false, readOnlyReason: null, managedBy: null, fileId: null, channelId: null, blobSha: null, contentUrl: null, ...over,
});

describe('paths and names', () => {
  it('splits a path', () => {
    expect(parentOf('pages/reports/week-37.md')).toBe('pages/reports');
    expect(parentOf('TEAM.md')).toBe('');
    expect(baseName('a/b/c.md')).toBe('c.md');
  });
  it('uploads go to a channel folder, never to channels/ itself or a git folder', () => {
    expect(acceptsUploads('channels/dev')).toBe(true);
    expect(acceptsUploads('channels')).toBe(false);
    expect(acceptsUploads('pages')).toBe(false);
    expect(acceptsUploads('')).toBe(false);
  });
  it('refuses names the repo would refuse', () => {
    expect(nameProblem('notes.md')).toBeNull();
    expect(nameProblem('')).toMatch(/name/i);
    expect(nameProblem('a/b')).toMatch(/slash/i);
    expect(nameProblem('..')).not.toBeNull();
    expect(nameProblem('.git')).not.toBeNull();
    expect(nameProblem('trailing.')).not.toBeNull();
    expect(nameProblem('x'.repeat(256))).not.toBeNull();
  });
  it('builds the Files links', () => {
    expect(filesHref('engineering')).toBe('/t/engineering/files');
    expect(filesHref('engineering', { folder: 'pages/reports', open: 'pages/reports/a.md' })).toBe('/t/engineering/files?path=pages%2Freports&open=pages%2Freports%2Fa.md');
  });
});

describe('filters and order', () => {
  const rows = [
    row({ path: 'a.png', mime: 'image/png', modifiedAt: '2026-10-01T10:00:00Z', by: { id: '1', name: 'Tester', kind: 'bot' } }),
    row({ path: 'b.md', modifiedAt: '2026-10-01T12:00:00Z', by: { id: '2', name: 'Nadia', kind: 'person' } }),
    row({ path: 'c.ts', modifiedAt: '2026-10-01T11:00:00Z' }),
    row({ path: 'dir', kind: 'folder' }),
  ];
  it('filters by type and by who made it; folders always stay', () => {
    expect(rows.filter((r) => matchesType(r, 'images')).map((r) => r.name)).toEqual(['a.png', 'dir']);
    expect(rows.filter((r) => matchesType(r, 'documents')).map((r) => r.name)).toEqual(['b.md', 'dir']);
    expect(rows.filter((r) => matchesType(r, 'code')).map((r) => r.name)).toEqual(['c.ts', 'dir']);
    expect(rows.filter((r) => matchesSource(r, 'bots')).map((r) => r.name)).toEqual(['a.png', 'dir']);
    expect(rows.filter((r) => matchesSource(r, 'people')).map((r) => r.name)).toEqual(['b.md', 'dir']);
  });
  it('sorts folders first, then files newest first or by name', () => {
    expect(sortRows(rows, 'recent').map((r) => r.name)).toEqual(['dir', 'b.md', 'c.ts', 'a.png']);
    expect(sortRows(rows, 'name').map((r) => r.name)).toEqual(['dir', 'a.png', 'b.md', 'c.ts']);
  });
});

describe('line diff', () => {
  it('finds the changed line with its context and numbers', () => {
    const d = lineDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(d.status).toBe('modified');
    expect([d.additions, d.deletions]).toEqual([1, 1]);
    const lines = d.hunks[0]?.lines ?? [];
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual(['context:one', 'del:two', 'add:TWO', 'context:three']);
    expect(lines[1]).toMatchObject({ oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ oldLine: null, newLine: 2 });
    expect(d.hunks[0]?.header).toBe('@@ -1,3 +1,3 @@');
  });
  it('a new file is all additions, a deleted one all deletions, identical text no hunks', () => {
    expect(lineDiff(null, 'a\nb\n')).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
    expect(lineDiff('a\nb\n', null)).toMatchObject({ status: 'deleted', additions: 0, deletions: 2 });
    expect(lineDiff('same\n', 'same\n')).toMatchObject({ status: 'unchanged', hunks: [] });
  });
  it('splits distant changes into two hunks', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[2] = 'changed 2';
    b[27] = 'changed 27';
    expect(lineDiff(a.join('\n'), b.join('\n')).hunks).toHaveLength(2);
  });
  it('does not stall on two large different files', () => {
    const t = Date.now();
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const d = lineDiff(a, b);
    expect(d.additions).toBe(3000);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('rendered diff blocks', () => {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  it('marks what came in and what went out, and keeps the rest', () => {
    const parts = diffBlocks([p('keep'), p('old')], [p('keep'), p('new')]);
    expect(parts.map((x) => x.type)).toEqual(['same', 'del', 'add']);
  });
  it('is quiet for an unchanged page', () => {
    expect(diffBlocks([p('a')], [p('a')]).every((x) => x.type === 'same')).toBe(true);
  });
});

describe('the day and time of a version', () => {
  it('reads like "Tue 14:02"', () => {
    expect(dayTime('2026-09-29T14:02:00')).toMatch(/^[A-Z][a-z]{2} 14:02$/);
  });
});
