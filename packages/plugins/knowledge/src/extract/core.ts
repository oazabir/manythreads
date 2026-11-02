// The text extractors (PLAN P8-32). ONE interface: `extract(bytes, kind) -> { text, metadata }`. This file is pure (no database, no imports from other
// packages) because it also runs inside a worker thread (worker.ts): a hostile file can only cost its own thread, which the host (index.ts) stops
// after a time limit. Every extractor is linear in the size of its input and bounded: a byte cap before anything runs, a cap on the text it returns.
//
// Nothing here parses nested structure with recursion: Markdown is read line by line (headings and code fences only), CSV is a single character
// scan, and a PDF is handed to pdfjs with its script and font features turned off.

export type ExtractKind = 'markdown' | 'text' | 'csv' | 'pdf' | 'html';

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


const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', copy: '(c)', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const SKIP_RAW = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'textarea', 'select']);
const SKIP_NESTED = new Set(['nav', 'aside', 'footer', 'form', 'dialog']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'br', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'hr', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'details', 'summary', 'address']);

/**
 * A web page as Markdown: headings, list items and paragraphs are kept, scripts, styles, navigation and forms are dropped, entities are decoded.
 * One left-to-right scan; a tag is looked for at most 4,096 characters ahead (a `<` with no `>` that near is text), a skipped element is skipped with
 * one search for its end, nesting is a counter, and the output stops at the limit. The result is then read as Markdown, so headings become sections.
 */
export function extractHtml(bytes: Uint8Array, limits: ExtractLimits): ExtractResult {
  const src = decodeText(bytes);
  const out: string[] = [];
  let outLen = 0;
  let title: string | null = null;
  let pre = 0;
  let pos = 0;
  let atLineStart = true;
  let pendingSpace = false;
  let gtAt = -1;
  let gtGone = false;
  const emit = (piece: string): void => {
    if (piece.length === 0 || outLen >= limits.maxChars) return;
    out.push(piece);
    outLen += piece.length;
    atLineStart = piece.endsWith('\n');
    pendingSpace = false;
  };
  const newline = (count: number): void => {
    if (outLen === 0) return;
    const tail = out.length > 0 ? out[out.length - 1]! : '';
    const have = /\n*$/.exec(tail)?.[0].length ?? 0;
    if (have < count) emit('\n'.repeat(count - have));
  };
  const text = (raw: string): void => {
    const decoded = decodeEntities(raw);
    if (pre > 0) {
      emit(decoded);
      return;
    }
    const words = decoded.split(/\s+/);
    const startsBlank = /^\s/.test(decoded);
    const endsBlank = /\s$/.test(decoded);
    let first = true;
    for (const w of words) {
      if (w.length === 0) continue;
      if (first) {
        emit(!atLineStart && (startsBlank || pendingSpace) ? ` ${w}` : w);
        first = false;
      } else emit(` ${w}`);
      if (outLen >= limits.maxChars) return;
    }
    if (endsBlank && !first) pendingSpace = true;
    else if (endsBlank && first) pendingSpace = true;
  };
  const indexOfClose = (name: string, from: number): number => {
    const re = new RegExp(`</${name}[\\s>/]`, 'gi');
    re.lastIndex = from;
    const m = re.exec(src);
    return m ? m.index : -1;
  };

  while (pos < src.length && outLen < limits.maxChars) {
    const lt = src.indexOf('<', pos);
    if (lt === -1) {
      text(src.slice(pos));
      break;
    }
    if (lt > pos) text(src.slice(pos, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      pos = end === -1 ? src.length : end + 3;
      continue;
    }
    // the nearest ">" after this "<"; remembered, so a run of "<" with no ">" (or a far one) is scanned once, not once per "<"
    if (!gtGone && gtAt <= lt) {
      gtAt = src.indexOf('>', lt + 1);
      if (gtAt === -1) gtGone = true;
    }
    const gt = gtGone ? -1 : gtAt;
    if (gt === -1 || gt - lt > 4096) {
      // not a tag: a stray "<" is text
      text('<');
      pos = lt + 1;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(lt, Math.min(gt + 1, lt + 64)));
    pos = gt + 1;
    if (!tag) continue;
    const closing = tag[1] === '/';
    const name = (tag[2] ?? '').toLowerCase();
    const selfClosed = src[gt - 1] === '/';
    if (!closing && name === 'title' && title === null) {
      const end = indexOfClose('title', pos);
      const raw = src.slice(pos, end === -1 ? Math.min(src.length, pos + 500) : Math.min(end, pos + 500));
      const t = decodeEntities(raw).replace(/\s+/g, ' ').trim();
      if (t.length > 0) title = clip(t, 200);
      pos = end === -1 ? src.length : end;
      continue;
    }
    if (!closing && SKIP_RAW.has(name) && !selfClosed) {
      const end = indexOfClose(name, pos);
      pos = end === -1 ? src.length : end;
      continue;
    }
    if (!closing && SKIP_NESTED.has(name) && !selfClosed) {
      const re = new RegExp(`<(/?)${name}[\\s>/]`, 'gi');
      re.lastIndex = pos;
      let depth = 1;
      let m: RegExpExecArray | null;
      // one pass over the rest of the page at most (the regex advances), so the nesting costs a counter
      while (depth > 0 && (m = re.exec(src)) !== null) depth += m[1] === '/' ? -1 : 1;
      pos = depth > 0 ? src.length : src.indexOf('>', re.lastIndex - 1) + 1 || src.length;
      continue;
    }
    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      newline(2);
      if (!closing) emit(`${'#'.repeat(Number(heading[1]))} `);
      else newline(2);
    } else if (name === 'li') {
      newline(1);
      if (!closing) emit('- ');
    } else if (name === 'pre') {
      newline(2);
      pre += closing ? -1 : 1;
      if (pre < 0) pre = 0;
    } else if (name === 'td' || name === 'th') {
      if (closing) emit(' | ');
    } else if (BLOCK.has(name)) {
      newline(name === 'br' || name === 'tr' ? 1 : 2);
    }
  }
  let md = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let truncated = outLen >= limits.maxChars || pos < src.length;
  if (md.length > limits.maxChars) {
    md = md.slice(0, limits.maxChars);
    truncated = true;
  }
  const read = extractMarkdown(new TextEncoder().encode(md.length === 0 ? ' ' : md), limits, true);
  return { text: read.text, metadata: { ...read.metadata, title: title ?? read.metadata.title, truncated: truncated || read.metadata.truncated } };
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
      case 'html':
        return extractHtml(bytes, limits);
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError('This file could not be read.');
  }
}
