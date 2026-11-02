// The shapes of the extractor interface (PLAN P8-32, P8-16): `extract(bytes, kind) -> { text, metadata, children? }`. Kept apart from the readers so each reader
// (core.ts for text, CSV, PDF and HTML; office.ts; mime.ts) can use them without importing the others.

export type ExtractKind = 'markdown' | 'text' | 'csv' | 'pdf' | 'html' | 'docx' | 'pptx' | 'xlsx' | 'eml';

/** Where a part of the text starts: a heading, a page or a range of rows. A chunk is labelled with the last section that starts at or before it. */
export interface ExtractSection {
  label: string;
  start: number;
}

export interface ExtractMetadata {
  /** A title found in the file (the first heading, the PDF's title, an email's subject), or null. */
  title: string | null;
  sections: ExtractSection[];
  /** Pages read, for a PDF. */
  pages?: number;
  /** Rows read, for a CSV or a spreadsheet (header rows not counted). */
  rows?: number;
  /** Slides read, for a presentation; sheets read, for a spreadsheet. */
  slides?: number;
  sheets?: number;
  /** True when the file was longer than what was kept: only the start is searchable. */
  truncated: boolean;
  /** For an email: the header lines that matter (from, to, cc, date, subject, message-id, and the receiving server's authentication verdict), each cut short. */
  headers?: Record<string, string>;
}

/** A file inside a file: an email's attachment. The caller decides what to do with it (the inbox makes each one an item of its own). */
export interface ExtractChild {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ExtractResult {
  text: string;
  metadata: ExtractMetadata;
  /** Files found inside this one, in order; only an email has any. */
  children?: ExtractChild[];
}

/** A refusal with a reason a person can read; the reason is what the document shows. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

/** A result from text that was found; a file with no text in it is refused plainly. */
export function finishResult(
  text: string,
  sections: ExtractSection[],
  title: string | null,
  truncated: boolean,
  extra: Partial<ExtractMetadata> = {},
  children?: ExtractChild[],
): ExtractResult {
  if (text.trim().length === 0) throw new ExtractError('No text was found in this file.');
  return { text, metadata: { title, sections, truncated, ...extra }, ...(children && children.length > 0 ? { children } : {}) };
}
