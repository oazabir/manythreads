import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyGrid, columnLetter, diffGrid, parseCsv, toGrid } from '../src/viewers/csv';

const fixture = readFileSync(new URL('../../../e2e/fixtures/files/signups.csv', import.meta.url), 'utf8');
const edit = (text: string, changes: Array<[number, number, string]>, delimiter = ','): string => {
  const doc = parseCsv(text, delimiter);
  const grid = toGrid(doc).map((r) => [...r]);
  for (const [r, c, v] of changes) (grid[r] ??= [])[c] = v;
  return applyGrid(doc, grid);
};

describe('csv parsing keeps every byte', () => {
  const samples: Record<string, string> = {
    plain: 'a,b,c\n1,2,3\n',
    'no trailing newline': 'a,b\n1,2',
    crlf: 'a,b\r\n1,2\r\n',
    quoted: 'a,"b, c","say ""hi"""\n1,"line\nbreak",3\n',
    ragged: 'a,b,c\n1\n1,2,3,4\n',
    blank: 'a,b\n\n1,2\n',
    unicode: 'name,city\nZoë,Köln\n',
    'ends with delimiter': 'a,b,\n1,2,\n',
    'quoted with junk': '"a"x,b\n',
    tsv: 'a\tb\n1\t2\n',
    empty: '',
    'one cell': 'x',
  };
  for (const [name, text] of Object.entries(samples)) {
    it(`an unedited grid writes ${name} back unchanged`, () => {
      const delimiter = name === 'tsv' ? '\t' : ',';
      const doc = parseCsv(text, delimiter);
      expect(applyGrid(doc, toGrid(doc))).toBe(text);
    });
  }

  it('reads values, quotes and line breaks into cells', () => {
    const doc = parseCsv('a,"b, c","say ""hi"""\n1,"line\nbreak",3\n');
    expect(doc.rows.map((r) => r.map((c) => c.value))).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', 'line\nbreak', '3'],
    ]);
    expect(doc.rows).toHaveLength(2);
    expect(doc.endsWithNewline).toBe(true);
  });

  it('numbers columns like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
});

describe('editing a cell changes that cell only (PLAN criterion 7)', () => {
  it('the signups fixture: one edited cell is the only difference in the file', () => {
    const next = edit(fixture, [[2, 1, '456']]);
    const before = fixture.split('\n');
    const after = next.split('\n');
    expect(after).toHaveLength(before.length);
    const changedLines = before.map((l, i) => (l === after[i] ? -1 : i)).filter((i) => i >= 0);
    expect(changedLines).toEqual([2]);
    expect(before[2]).toBe('2026-W37,455,1.1%');
    expect(after[2]).toBe('2026-W37,456,1.1%');
    // and the quoted row below keeps its quotes untouched
    expect(after[3]).toBe('"2026-W38","470","1.0%"');
  });

  it('diff at cell level: exactly one cell differs between the two files', () => {
    const next = edit(fixture, [[2, 1, '456']]);
    const a = toGrid(parseCsv(fixture));
    const b = toGrid(parseCsv(next));
    const diffs: string[] = [];
    a.forEach((row, r) => row.forEach((v, c) => v !== b[r]?.[c] && diffs.push(`${r}:${c}`)));
    expect(diffs).toEqual(['2:1']);
  });

  it('only bytes inside the cell span move: prefix and suffix are identical', () => {
    const doc = parseCsv(fixture);
    const cell = doc.rows[2]?.[1];
    expect(cell).toBeDefined();
    if (!cell) return;
    const next = edit(fixture, [[2, 1, '45500']]);
    expect(next.slice(0, cell.start)).toBe(fixture.slice(0, cell.start));
    expect(next.slice(cell.start + '45500'.length)).toBe(fixture.slice(cell.end));
  });

  it('editing a quoted cell keeps it quoted and escapes quotes; a plain cell is quoted only when it must be', () => {
    expect(edit('a,"b"\n', [[0, 1, 'say "x"']])).toBe('a,"say ""x"""\n');
    expect(edit('a,b\n', [[0, 1, 'x,y']])).toBe('a,"x,y"\n');
    expect(edit('a,b\n', [[0, 1, 'two\nlines']])).toBe('a,"two\nlines"\n');
    expect(edit('a,b\n', [[0, 1, 'plain']])).toBe('a,plain\n');
  });

  it('two edited cells change two cells; editing back changes nothing', () => {
    const doc = parseCsv(fixture);
    const grid = toGrid(doc).map((r) => [...r]);
    grid[1]![1] = '999';
    grid[3]![2] = '2.0%';
    expect(diffGrid(doc, grid)).toHaveLength(2);
    grid[1]![1] = '410';
    grid[3]![2] = '1.0%';
    expect(applyGrid(doc, grid)).toBe(fixture);
  });

  it('keeps CRLF files CRLF and untouched ragged rows ragged', () => {
    expect(edit('a,b\r\n1,2\r\n', [[1, 0, 'x']])).toBe('a,b\r\nx,2\r\n');
    const ragged = 'a,b,c\n1\n1,2,3,4\n';
    expect(edit(ragged, [[0, 0, 'A']])).toBe('A,b,c\n1\n1,2,3,4\n');
  });

  it('fills a ragged row only when the person types in a missing cell', () => {
    expect(edit('a,b,c\n1\n', [[1, 2, 'z']])).toBe('a,b,c\n1,,z\n');
  });

  it('adds rows at the bottom with the file\'s line break and trailing newline habit; an empty new row is dropped', () => {
    const doc = parseCsv('a,b\r\n1,2\r\n');
    expect(applyGrid(doc, [...toGrid(doc), ['3', '4,5']])).toBe('a,b\r\n1,2\r\n3,"4,5"\r\n');
    expect(applyGrid(doc, [...toGrid(doc), ['', '']])).toBe('a,b\r\n1,2\r\n');
    const noNl = parseCsv('a,b\n1,2');
    expect(applyGrid(noNl, [...toGrid(noNl), ['3', '4']])).toBe('a,b\n1,2\n3,4');
  });

  it('writes the first rows of an empty file', () => {
    const doc = parseCsv('');
    expect(applyGrid(doc, [['a', 'b']])).toBe('a,b\n');
  });
});
