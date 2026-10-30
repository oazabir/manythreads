import type { ExtractSection } from './extract/index.ts';

// Cutting a document's text into passages (PLAN P8-07). A passage is about TARGET characters, ends on a paragraph break where it can, never crosses
// from one section (a heading, a page, a block of rows) into the next, and is never longer than MAX (the database refuses more). Every passage keeps
// its exact position in the text: `text.slice(start, end) === chunk.text`, so a citation can point at the place. One pass over the text, no
// backtracking: a 900,000-character file costs 900,000 steps, whatever its shape (one giant line, ten thousand blank lines).

export const CHUNK_TARGET = 1100;
export const CHUNK_MAX = 2000;
/** The most passages one document may make; a longer text keeps its start (the document says so). */
export const MAX_CHUNKS_PER_DOCUMENT = 2000;

export interface Chunk {
  ordinal: number;
  text: string;
  section: string | null;
  start: number;
  end: number;
}

interface Piece {
  start: number;
  end: number;
}

/** Paragraphs: runs of text between blank lines, trimmed of leading and trailing whitespace. */
function paragraphs(text: string): Piece[] {
  const out: Piece[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(text[i] as string)) i += 1;
    if (i >= n) break;
    const start = i;
    let end = i;
    // read lines until a blank line
    for (;;) {
      let eol = text.indexOf('\n', i);
      if (eol === -1) eol = n;
      const line = text.slice(i, eol);
      if (line.trim().length > 0) end = eol;
      i = eol + 1;
      if (i >= n) break;
      // a blank line ends the paragraph
      let j = i;
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j += 1;
      if (text[j] === '\n') break;
    }
    out.push({ start, end: Math.min(end, n) });
  }
  return out;
}

/** Splits one over-long paragraph at sentence ends or spaces, as close to CHUNK_TARGET as it can get, and at CHUNK_MAX at the most. */
function splitLong(text: string, p: Piece): Piece[] {
  const out: Piece[] = [];
  let start = p.start;
  while (p.end - start > CHUNK_MAX) {
    const windowEnd = start + CHUNK_MAX;
    let cut = -1;
    // prefer the last sentence end in the second half of the window, then the last space there
    for (let k = windowEnd; k > start + CHUNK_TARGET / 2; k--) {
      const c = text[k - 1];
      if ((c === '.' || c === '!' || c === '?' || c === '\n') && (text[k] === ' ' || text[k] === '\n')) {
        cut = k;
        break;
      }
    }
    if (cut === -1) {
      for (let k = windowEnd; k > start + CHUNK_TARGET / 2; k--) {
        if (text[k - 1] === ' ' || text[k - 1] === '\t') {
          cut = k;
          break;
        }
      }
    }
    if (cut === -1) cut = windowEnd;
    let end = cut;
    while (end > start && /\s/.test(text[end - 1] as string)) end -= 1;
    if (end > start) out.push({ start, end });
    start = cut;
    while (start < p.end && /\s/.test(text[start] as string)) start += 1;
  }
  if (p.end > start) out.push({ start, end: p.end });
  return out;
}

/** The label of the section a position falls in (the last section that starts at or before it), or null. */
function labeller(sections: readonly ExtractSection[]): (pos: number) => string | null {
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  let at = -1;
  return (pos) => {
    while (at + 1 < sorted.length && (sorted[at + 1] as ExtractSection).start <= pos) at += 1;
    return at >= 0 ? (sorted[at] as ExtractSection).label : null;
  };
}

export function chunkText(text: string, sections: readonly ExtractSection[]): { chunks: Chunk[]; truncated: boolean } {
  const labelAt = labeller(sections);
  const pieces: Array<Piece & { section: string | null }> = [];
  for (const p of paragraphs(text)) {
    const section = labelAt(p.start);
    if (p.end - p.start > CHUNK_MAX) for (const q of splitLong(text, p)) pieces.push({ ...q, section });
    else pieces.push({ ...p, section });
  }
  const chunks: Chunk[] = [];
  let truncated = false;
  let current: { start: number; end: number; section: string | null } | null = null;
  const flush = (): void => {
    if (!current) return;
    chunks.push({ ordinal: chunks.length, text: text.slice(current.start, current.end), section: current.section, start: current.start, end: current.end });
    current = null;
  };
  for (const piece of pieces) {
    if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
      truncated = true;
      current = null;
      break;
    }
    if (current === null) {
      current = { start: piece.start, end: piece.end, section: piece.section };
      continue;
    }
    const joined = piece.end - current.start;
    if (piece.section !== current.section || joined > CHUNK_TARGET) {
      flush();
      current = { start: piece.start, end: piece.end, section: piece.section };
    } else current.end = piece.end;
  }
  if (current !== null && chunks.length < MAX_CHUNKS_PER_DOCUMENT) flush();
  else if (current !== null) truncated = true;
  return { chunks, truncated };
}
