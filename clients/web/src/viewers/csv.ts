/*
 * CSV with source spans. The viewer edits a grid but saves by patching the original text: only the cells whose value changed are
 * replaced (their exact byte span), new rows are appended, and every other byte (quoting, line endings, ragged rows, trailing
 * newline) stays as it was. That is what makes "editing a cell changes that cell only" true in the commit diff (PLAN criterion 7).
 */

export type CsvCell = {
  value: string;
  /** Span of the raw cell in the source text, quotes included, delimiter and line break excluded. */
  start: number;
  end: number;
  quoted: boolean;
};

export type CsvDoc = {
  text: string;
  delimiter: string;
  /** The line break the file uses (the first one found); new rows use it. */
  eol: '\n' | '\r\n';
  endsWithNewline: boolean;
  rows: CsvCell[][];
};

export const delimiterFor = (path: string): string => (/\.tsv$/i.test(path) ? '\t' : ',');

export function parseCsv(text: string, delimiter = ','): CsvDoc {
  const rows: CsvCell[][] = [];
  let eol: '\n' | '\r\n' | null = null;
  let i = 0;
  const n = text.length;
  let row: CsvCell[] = [];
  const endRow = () => {
    rows.push(row);
    row = [];
  };
  // an empty file has no rows; a file that ends with a line break has no empty row after it
  while (i < n) {
    // one cell
    const start = i;
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          value += text.slice(i);
          i = n;
          break;
        }
        value += text.slice(i, q);
        if (text[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      // junk after the closing quote belongs to the cell up to the next delimiter or line break
      const junkStart = i;
      while (i < n && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') i++;
      value += text.slice(junkStart, i);
    } else {
      while (i < n && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') i++;
      value = text.slice(start, i);
    }
    row.push({ value, start, end: i, quoted });
    if (i >= n) {
      endRow();
      break;
    }
    if (text[i] === delimiter) {
      i++;
      if (i >= n) {
        // a delimiter at the very end of the file opens one more, empty, cell
        row.push({ value: '', start: i, end: i, quoted: false });
        endRow();
      }
      continue;
    }
    // line break
    const crlf = text[i] === '\r' && text[i + 1] === '\n';
    eol ??= crlf ? '\r\n' : '\n';
    i += crlf ? 2 : 1;
    endRow();
  }
  const last = text.at(-1);
  return { text, delimiter, eol: eol ?? '\n', endsWithNewline: last === '\n' || last === '\r', rows };
}

/** The grid the editor shows: every row padded to the widest one. */
export function toGrid(doc: CsvDoc): string[][] {
  const width = Math.max(1, ...doc.rows.map((r) => r.length));
  return doc.rows.map((r) => Array.from({ length: width }, (_, c) => r[c]?.value ?? ''));
}

/** Quote a value only when the format needs it (or the cell was quoted before and still can be). */
export function formatCell(value: string, delimiter: string, wasQuoted = false): string {
  const needs = wasQuoted || value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value);
  return needs ? `"${value.replaceAll('"', '""')}"` : value;
}

export type CsvEdit = { row: number; col: number; value: string };

/** The cells of `grid` that differ from the file (same positions only; rows beyond the file are appended rows, not edits). */
export function diffGrid(doc: CsvDoc, grid: readonly (readonly string[])[]): CsvEdit[] {
  const edits: CsvEdit[] = [];
  for (let r = 0; r < Math.min(doc.rows.length, grid.length); r++) {
    const cells = doc.rows[r] ?? [];
    const line = grid[r] ?? [];
    for (let c = 0; c < line.length; c++) {
      const before = cells[c]?.value ?? '';
      if ((line[c] ?? '') !== before) edits.push({ row: r, col: c, value: line[c] ?? '' });
    }
  }
  return edits;
}

/** The file's text with `grid`'s changes applied by patching: edited cells replaced in place, extra rows appended. */
export function applyGrid(doc: CsvDoc, grid: readonly (readonly string[])[]): string {
  type Patch = { start: number; end: number; text: string };
  const patches: Patch[] = [];
  for (const e of diffGrid(doc, grid)) {
    const cells = doc.rows[e.row] ?? [];
    const cell = cells[e.col];
    if (cell) {
      patches.push({ start: cell.start, end: cell.end, text: formatCell(e.value, doc.delimiter, cell.quoted) });
    } else if (e.value !== '' && cells.length > 0) {
      // a ragged row that has no such cell yet: add the missing delimiters and the value at the end of the row
      const at = cells[cells.length - 1]?.end ?? 0;
      patches.push({ start: at, end: at, text: doc.delimiter.repeat(e.col - cells.length + 1) + formatCell(e.value, doc.delimiter) });
    }
  }
  let out = doc.text;
  for (const p of patches.sort((a, b) => b.start - a.start)) out = out.slice(0, p.start) + p.text + out.slice(p.end);

  // rows the person added at the bottom (a new row left completely empty is dropped)
  const added = grid.slice(doc.rows.length).filter((r) => r.some((v) => v !== ''));
  if (added.length > 0) {
    const lines = added.map((r) => r.map((v) => formatCell(v, doc.delimiter)).join(doc.delimiter));
    const needsBreak = out.length > 0 && !/[\r\n]$/.test(out);
    out += (needsBreak ? doc.eol : '') + lines.join(doc.eol) + (doc.endsWithNewline || out.length === 0 ? doc.eol : '');
  }
  return out;
}

/** `A`, `B`, ... `Z`, `AA`. */
export function columnLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
