import type { ExtractLimits } from './core.ts';
import { ExtractError, finishResult, type ExtractResult, type ExtractSection } from './types.ts';
import { scanXml, xmlAttr } from './xml.ts';
import { ZipArchive } from './zip.ts';

// .docx, .pptx and .xlsx read as zipped XML (PLAN P8-16), no office suite involved. Each reader opens the zip with the bounded reader in zip.ts, takes the
// few parts that hold text, and walks each with the linear scanner in xml.ts. Text is cut at `limits.maxChars`; a part is cut at the same length before it
// is decoded, so a huge document costs a bounded amount of work. Formatting is dropped except what helps a reader of the result: headings, table cells and
// slide and sheet names.

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
// control characters other than tab and newline become blanks (a NUL would make the database refuse the text)
// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');

/** Collects lines of text and the sections that start in them, stopping at the character limit. */
class Out {
  readonly lines: string[] = [];
  readonly sections: ExtractSection[] = [];
  length = 0;
  truncated = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get full(): boolean {
    return this.length >= this.max;
  }
  section(label: string): void {
    this.sections.push({ label: clip(label, 200), start: this.length });
  }
  line(text: string): void {
    if (this.full) {
      this.truncated = true;
      return;
    }
    this.lines.push(text);
    this.length += text.length + 1;
  }
  text(): string {
    const joined = this.lines.join('\n').replace(/\n{3,}/g, '\n\n');
    return joined.length > this.max ? joined.slice(0, this.max) : joined;
  }
}

function open(bytes: Uint8Array): ZipArchive {
  // an Office file starts with the zip signature; the older binary formats (.doc, .ppt, .xls) do not
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ExtractError('This is not a current Office file (.docx, .pptx or .xlsx). Older .doc, .ppt and .xls files are not read; save a copy in the current format.');
  }
  return new ZipArchive(bytes);
}

// ---- Word ---------------------------------------------------------------------------------------------------------------------------

export function extractDocx(bytes: Uint8Array, limits: ExtractLimits): ExtractResult {
  const zip = open(bytes);
  const main = zip.read('word/document.xml');
  if (!main) throw new ExtractError('This is not a Word document: it has no text part.');
  const out = new Out(limits.maxChars);
  let title: string | null = null;

  const readPart = (xml: string, withHeadings: boolean): void => {
    let paragraph = '';
    let heading = 0;
    let inText = false;
    let inInstr = false;
    let tables = 0;
    let cells: string[] = [];
    let cell = '';
    const flush = (): void => {
      const text = paragraph.replace(/[ \t]+/g, ' ').trim();
      paragraph = '';
      if (tables > 0) {
        // inside a table the paragraphs of a cell are joined; the row is written when it ends
        if (text.length > 0) cell += cell.length > 0 ? ` ${text}` : text;
      } else if (text.length > 0) {
        if (withHeadings && heading > 0) {
          out.section(text);
          title ??= clip(text, 200);
          out.line('');
          out.line(`${'#'.repeat(heading)} ${text}`);
          out.line('');
        } else out.line(text);
      }
      heading = 0;
    };
    scanXml(
      xml,
      {
        open(name, attrs) {
          if (name === 'w:t') inText = true;
          else if (name === 'w:instrText') inInstr = true;
          else if (name === 'w:tab') paragraph += '\t';
          else if (name === 'w:br' || name === 'w:cr') paragraph += '\n';
          else if (name === 'w:pStyle') {
            const v = xmlAttr(attrs, 'w:val') ?? '';
            const m = /^(?:Heading|heading)\s?([1-6])$/.exec(v);
            if (m) heading = Number(m[1]);
            else if (v === 'Title' || v === 'title') heading = 1;
          } else if (name === 'w:tbl') tables += 1;
        },
        close(name) {
          if (name === 'w:t') inText = false;
          else if (name === 'w:instrText') inInstr = false;
          else if (name === 'w:p') flush();
          else if (name === 'w:tc') {
            if (tables === 1) {
              cells.push(cell.trim());
              cell = '';
            }
          } else if (name === 'w:tr') {
            if (tables === 1) {
              const row = cells.filter((c) => c.length > 0).join(' | ');
              cells = [];
              if (row.length > 0) out.line(row);
            }
          } else if (name === 'w:tbl') tables = Math.max(0, tables - 1);
        },
        text(t) {
          if (inText && !inInstr) paragraph += t;
        },
      },
      () => out.full,
    );
    flush();
  };

  readPart(utf8(main), true);
  for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const part = zip.read(extra);
    if (part && !out.full) {
      out.line('');
      readPart(utf8(part), false);
    }
  }
  const text = clean(out.text()).trim();
  return finishResult(text, out.sections, title, out.truncated);
}

// ---- PowerPoint ---------------------------------------------------------------------------------------------------------------------

const numberIn = (name: string): number => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function paragraphsOf(xml: string, out: string[], limit: () => boolean): void {
  let paragraph = '';
  let inText = false;
  scanXml(
    xml,
    {
      open(name) {
        if (name === 'a:t') inText = true;
        else if (name === 'a:br') paragraph += '\n';
      },
      close(name) {
        if (name === 'a:t') inText = false;
        else if (name === 'a:p') {
          const t = paragraph.replace(/[ \t]+/g, ' ').trim();
          paragraph = '';
          if (t.length > 0) out.push(t);
        }
      },
      text(t) {
        if (inText) paragraph += t;
      },
    },
    limit,
  );
  const rest = paragraph.trim();
  if (rest.length > 0) out.push(rest);
}

export function extractPptx(bytes: Uint8Array, limits: ExtractLimits): ExtractResult {
  const zip = open(bytes);
  const slides = zip.names('ppt/slides/slide').filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => numberIn(a) - numberIn(b));
  if (slides.length === 0) throw new ExtractError('This is not a PowerPoint presentation: it has no slides.');
  const out = new Out(limits.maxChars);
  let title: string | null = null;
  let read = 0;
  for (const name of slides) {
    if (out.full) {
      out.truncated = true;
      break;
    }
    const part = zip.read(name);
    if (!part) continue;
    read += 1;
    const n = numberIn(name);
    const paragraphs: string[] = [];
    paragraphsOf(utf8(part), paragraphs, () => paragraphs.length > 5_000);
    const first = paragraphs[0];
    const label = first ? `Slide ${n}: ${clip(first, 120)}` : `Slide ${n}`;
    out.section(label);
    if (first) title ??= clip(first, 200);
    out.line(`## ${label}`);
    for (const p of paragraphs.slice(first ? 1 : 0)) out.line(p);
    const notesPart = zip.read(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notesPart) {
      const notes: string[] = [];
      paragraphsOf(utf8(notesPart), notes, () => notes.length > 2_000);
      // the notes page repeats the slide number as its own paragraph; a lone number is not a note
      const real = notes.filter((t) => !/^\d{1,4}$/.test(t));
      if (real.length > 0) {
        out.line('Speaker notes:');
        for (const t of real) out.line(t);
      }
    }
    out.line('');
  }
  const text = clean(out.text()).trim();
  return finishResult(text, out.sections, title, out.truncated, { slides: read });
}

// ---- Excel --------------------------------------------------------------------------------------------------------------------------

/** "AB" -> 27 (zero-based index 27 means column AC; this returns the zero-based index of the letters). */
function columnIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length && i < 4; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function sharedStrings(zip: ZipArchive, maxStrings: number, maxCell: number): string[] {
  const part = zip.read('xl/sharedStrings.xml');
  if (!part) return [];
  const strings: string[] = [];
  let current = '';
  let inItem = false;
  let inText = false;
  scanXml(
    utf8(part),
    {
      open(name) {
        if (name === 'si') {
          inItem = true;
          current = '';
        } else if (name === 't' && inItem) inText = true;
      },
      close(name) {
        if (name === 't') inText = false;
        else if (name === 'si') {
          strings.push(clip(current.trim(), maxCell));
          inItem = false;
        }
      },
      text(t) {
        if (inText && current.length < maxCell) current += t;
      },
    },
    () => strings.length >= maxStrings,
  );
  return strings;
}

export function extractXlsx(bytes: Uint8Array, limits: ExtractLimits): ExtractResult {
  const zip = open(bytes);
  const sheetFiles = zip.names('xl/worksheets/sheet').filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => numberIn(a) - numberIn(b));
  if (sheetFiles.length === 0) throw new ExtractError('This is not an Excel workbook: it has no sheets.');
  const shared = sharedStrings(zip, 500_000, limits.maxCellChars);
  // sheet names, in the workbook's order, which is the order of the sheet files in every file Excel and the common libraries write
  const names: string[] = [];
  const book = zip.read('xl/workbook.xml');
  if (book) {
    scanXml(utf8(book), {
      open(name, attrs) {
        if (name === 'sheet') names.push(xmlAttr(attrs, 'name') ?? '');
      },
    });
  }
  const out = new Out(limits.maxChars);
  let rowsRead = 0;
  let sheetsRead = 0;
  let title: string | null = null;
  const MAX_ROWS = 100_000;
  for (let s = 0; s < sheetFiles.length; s++) {
    if (out.full) {
      out.truncated = true;
      break;
    }
    const part = zip.read(sheetFiles[s] as string);
    if (!part) continue;
    sheetsRead += 1;
    const sheetName = names[s] && names[s]!.length > 0 ? names[s]! : `Sheet ${s + 1}`;
    out.section(`Sheet ${sheetName}`);
    out.line(`## ${sheetName}`);
    title ??= clip(sheetName, 200);
    let header: string[] | null = null;
    let row: string[] = [];
    let cellCol = 0;
    let cellType = '';
    let inValue = false;
    let inInline = false;
    let inInlineText = false;
    let value = '';
    let inCell = false;
    let rowCount = 0;
    const endRow = (): void => {
      if (row.some((c) => c !== undefined && c.length > 0)) {
        if (header === null) header = row.map((c, i) => (c && c.length > 0 ? c : `column ${i + 1}`));
        else {
          const h: string[] = header;
          const line = row
            .map((c, i) => (c && c.length > 0 ? `${h[i] ?? `column ${i + 1}`}: ${c}` : ''))
            .filter((x) => x.length > 0)
            .join('; ');
          if (line.length > 0) {
            out.line(line);
            rowsRead += 1;
          }
        }
      }
      row = [];
    };
    scanXml(
      utf8(part),
      {
        open(name, attrs) {
          if (name === 'row') row = [];
          else if (name === 'c') {
            inCell = true;
            value = '';
            cellType = xmlAttr(attrs, 't') ?? '';
            const ref = xmlAttr(attrs, 'r') ?? '';
            const letters = /^[A-Za-z]{1,4}/.exec(ref)?.[0].toUpperCase() ?? '';
            cellCol = letters.length > 0 ? columnIndex(letters) : row.length;
          } else if (inCell && name === 'v') inValue = true;
          else if (inCell && name === 'is') inInline = true;
          else if (inInline && name === 't') inInlineText = true;
        },
        close(name) {
          if (name === 'v') inValue = false;
          else if (name === 't') inInlineText = false;
          else if (name === 'is') inInline = false;
          else if (name === 'c') {
            inCell = false;
            if (cellCol >= 0 && cellCol < limits.maxColumns) {
              let shown = value.trim();
              if (cellType === 's') shown = shared[Number(shown)] ?? '';
              else if (cellType === 'b') shown = shown === '1' ? 'TRUE' : 'FALSE';
              while (row.length < cellCol) row.push('');
              row[cellCol] = clip(shown, limits.maxCellChars);
            }
          } else if (name === 'row') {
            rowCount += 1;
            endRow();
          }
        },
        text(t) {
          if ((inValue || inInlineText) && value.length < limits.maxCellChars) value += t;
        },
      },
      () => out.full || rowCount > MAX_ROWS,
    );
    if (rowCount > MAX_ROWS) out.truncated = true;
    out.line('');
  }
  const text = clean(out.text()).trim();
  return finishResult(text, out.sections, title, out.truncated, { rows: rowsRead, sheets: sheetsRead });
}

