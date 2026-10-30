// The text extractors (PLAN P8-32). ONE interface: `extract(bytes, kind) -> { text, metadata }`. This file is pure (no database, no imports from other
// packages) because it also runs inside a worker thread (worker.ts): a hostile file can only cost its own thread, which the host (index.ts) stops
// after a time limit. Every extractor is linear in the size of its input and bounded: a byte cap before anything runs, a cap on the text it returns.
//
// Nothing here parses nested structure with recursion: Markdown is read line by line (headings and code fences only), CSV is a single character
// scan, and a PDF is handed to pdfjs with its script and font features turned off.

export type ExtractKind = 'markdown' | 'text' | 'csv' | 'pdf';

/** Where a part of the text starts: a heading, a page or a range of rows. A chunk is labelled with the last section that starts at or before it. */
export interface ExtractSection {
  label: string;
  start: number;
}

export interface ExtractMetadata {
  /** A title found in the file (the first heading, the PDF's title), or null. */
  title: string | null;
  sections: ExtractSection[];
  /** Pages read, for a PDF. */
  pages?: number;
  /** Rows read, for a CSV (the header row not counted). */
  rows?: number;
  /** True when the file was longer than what was kept: only the start is searchable. */
  truncated: boolean;
}

export interface ExtractResult {
  text: string;
  metadata: ExtractMetadata;
}

/** A refusal with a reason a person can read; the reason is what the document shows. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface ExtractLimits {
  /** The most characters of text kept; the rest is dropped and `truncated` is set. */
  maxChars: number;
  /** The most PDF pages read. */
  maxPages: number;
  /** The most CSV columns read per row, and characters kept per cell. */
  maxColumns: number;
  maxCellChars: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxChars: 900_000, maxPages: 300, maxColumns: 100, maxCellChars: 2_000 };

const SECTION_LABEL_MAX = 200;
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The text of a file that should be text: UTF-8, no byte order mark, one kind of line break, no control characters, never a NUL. */
export function decodeText(bytes: Uint8Array): string {
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) throw new ExtractError('This file looks like a binary file, not text.');
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

function finish(text: string, sections: ExtractSection[], title: string | null, truncated: boolean, extra: Partial<ExtractMetadata> = {}): ExtractResult {
  if (text.trim().length === 0) throw new ExtractError('No text was found in this file.');
  return { text, metadata: { title, sections, truncated, ...extra } };
}

/** Markdown and plain text: the text as it is. Markdown headings (outside code fences) become sections, nested as "Parent > Child". */
export function extractMarkdown(bytes: Uint8Array, limits: ExtractLimits, headings: boolean): ExtractResult {
  let text = decodeText(bytes);
  let truncated = false;
  if (text.length > limits.maxChars) {
    text = text.slice(0, limits.maxChars);
    truncated = true;
  }
  const sections: ExtractSection[] = [];
  let title: string | null = null;
  if (headings) {
    const stack: string[] = [];
    let fence: string | null = null;
    let pos = 0;
    while (pos <= text.length) {
      let eol = text.indexOf('\n', pos);
      if (eol === -1) eol = text.length;
      // only the start of a line is looked at, so a very long line costs one comparison, not a scan
      const head = text.slice(pos, Math.min(eol, pos + 400));
      const fenceMatch = /^ {0,3}(```|~~~)/.exec(head);
      if (fenceMatch) {
        const mark = fenceMatch[1] ?? '';
        if (fence === null) fence = mark;
        else if (fence === mark) fence = null;
      } else if (fence === null) {
        const h = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(head);
        if (h) {
          const level = (h[1] ?? '#').length;
          const label = (h[2] ?? '').trim();
          if (label.length > 0) {
            stack.length = Math.min(stack.length, level - 1);
            while (stack.length < level - 1) stack.push('');
            stack[level - 1] = label;
            sections.push({ label: clip(stack.filter(Boolean).join(' > '), SECTION_LABEL_MAX), start: pos });
            title ??= clip(label, 200);
          }
        }
      }
      pos = eol + 1;
    }
  }
  return finish(text, sections, title, truncated);
}

/**
 * CSV: one line of text per row, "column: value; column: value", so a search for a value finds its row with the column names beside it. Quoted
 * cells (with doubled quotes and line breaks) and a comma, semicolon or tab separator are handled. Sections are blocks of 50 rows.
 */
export function extractCsv(bytes: Uint8Array, limits: ExtractLimits): ExtractResult {
  const src = decodeText(bytes);
  const head = src.slice(0, 4096);
  const first = head.split('\n', 1)[0] ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [d, first.split(d).length - 1]);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let cellLen = 0;
  let inQuotes = false;
  let columns = 0;
  let kept = 0;
  let truncated = false;
  const MAX_ROWS = 100_000;
  const pushCell = (): void => {
    if (columns < limits.maxColumns) row.push(cell.trim());
    else truncated = true;
    columns += 1;
    cell = '';
    cellLen = 0;
  };
  const pushRow = (): void => {
    pushCell();
    if (row.some((c) => c.length > 0)) {
      rows.push(row);
      kept += 1;
    }
    row = [];
    columns = 0;
  };
  for (let i = 0; i < src.length && kept <= MAX_ROWS; i++) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          if (cellLen < limits.maxCellChars) cell += '"';
          cellLen += 1;
          i += 1;
        } else inQuotes = false;
      } else {
        if (cellLen < limits.maxCellChars) cell += ch === '\n' ? ' ' : ch;
        else truncated = true;
        cellLen += 1;
      }
    } else if (ch === '"' && cell.length === 0) inQuotes = true;
    else if (ch === delimiter) pushCell();
    else if (ch === '\n') pushRow();
    else {
      if (cellLen < limits.maxCellChars) cell += ch;
      else truncated = true;
      cellLen += 1;
    }
  }
  if (cell.length > 0 || row.length > 0) pushRow();
  if (kept > MAX_ROWS) truncated = true;

  const header = rows[0];
  if (!header || rows.length < 2) throw new ExtractError('This CSV file has no rows below its header.');
  const names = header.map((h, i) => (h.length > 0 ? h : `column ${i + 1}`));
  const lines: string[] = [];
  const sections: ExtractSection[] = [];
  let length = 0;
  for (let r = 1; r < rows.length; r++) {
    if (length >= limits.maxChars) {
      truncated = true;
      break;
    }
    if ((r - 1) % 50 === 0) {
      const last = Math.min(r + 49, rows.length - 1);
      sections.push({ label: `Rows ${r} to ${last}`, start: length });
    }
    const line = (rows[r] ?? [])
      .map((v, i) => (v.length > 0 ? `${names[i] ?? `column ${i + 1}`}: ${v}` : ''))
      .filter((s) => s.length > 0)
      .join('; ');
    if (line.length === 0) continue;
    lines.push(line);
    length += line.length + 1;
  }
  const text = lines.join('\n').slice(0, limits.maxChars);
  return finish(text, sections, null, truncated, { rows: Math.min(rows.length - 1, MAX_ROWS) });
}

/** PDF text, page by page (a section per page). Scripts, fonts and forms are not run or loaded. A scan with no text layer is refused plainly. */
export async function extractPdf(bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractResult> {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new ExtractError('This file is not a readable PDF.');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'PasswordException') throw new ExtractError('This PDF is protected with a password.');
      throw new ExtractError('This file is not a readable PDF.');
    }
    const pages = Math.min(doc.numPages, limits.maxPages);
    let truncated = doc.numPages > pages;
    const parts: string[] = [];
    const sections: ExtractSection[] = [];
    let length = 0;
    for (let p = 1; p <= pages && length < limits.maxChars; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line.length > 0) lines.push(line);
      // a PDF's text may carry control characters (a NUL would make the database refuse the passage): they become blanks, as in a text file
      // eslint-disable-next-line no-control-regex
      const pageText = lines.map((l) => l.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/[ \t]+/g, ' ').trim()).filter((l) => l.length > 0).join('\n');
      page.cleanup();
      if (pageText.length === 0) continue;
      sections.push({ label: `Page ${p}`, start: length });
      parts.push(pageText);
      length += pageText.length + 2;
    }
    if (length >= limits.maxChars) truncated = true;
    const text = parts.join('\n\n').slice(0, limits.maxChars);
    if (text.trim().length === 0) {
      throw new ExtractError('No text was found in this PDF. It may be a scan of paper pages, which cannot be read yet.');
    }
    let title: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const t = (meta.info as { Title?: unknown } | undefined)?.Title;
      if (typeof t === 'string' && t.trim().length > 0) title = clip(t.trim(), 200);
    } catch {
      // a PDF with unreadable metadata is still a PDF
    }
    return finish(text, sections, title, truncated, { pages: doc.numPages });
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** The one entry point: bytes and a kind in, text and metadata out. Rejects with an `ExtractError` carrying a plain reason. */
export async function extract(bytes: Uint8Array, kind: ExtractKind, limits: ExtractLimits = DEFAULT_LIMITS): Promise<ExtractResult> {
  try {
    switch (kind) {
      case 'markdown':
        return extractMarkdown(bytes, limits, true);
      case 'text':
        return extractMarkdown(bytes, limits, false);
      case 'csv':
        return extractCsv(bytes, limits);
      case 'pdf':
        return await extractPdf(bytes, limits);
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError('This file could not be read.');
  }
}
