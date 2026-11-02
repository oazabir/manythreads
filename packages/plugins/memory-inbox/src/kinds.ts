import type { ExtractKind } from '@manythreads/sdk/extract';
import type { InboxKind } from '@manythreads/shared';

// What a dropped file is, from its name. Only the name is read here: nothing about the bytes is trusted until the extractor has them. The kinds the
// platform cannot read yet (pictures, recordings, bundles) are still recognised, so the item says so plainly instead of failing with a stack.

const BY_EXTENSION: Readonly<Record<string, InboxKind>> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  log: 'text',
  csv: 'csv',
  tsv: 'csv',
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  xlsx: 'xlsx',
  eml: 'eml',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  heic: 'image',
  webp: 'image',
  gif: 'image',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  // a foreign OKF bundle or digest
  zip: 'bundle',
  okf: 'bundle',
};

export function kindOfName(name: string): InboxKind {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'unknown';
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'unknown';
}

/** The extractor's kind for an inbox kind, or null when the extractor cannot read it. `link` is not extracted at all (the page is never fetched). */
export function extractKindOf(kind: InboxKind): ExtractKind | null {
  switch (kind) {
    case 'markdown':
    case 'text':
    case 'csv':
    case 'pdf':
    case 'docx':
    case 'pptx':
    case 'xlsx':
    case 'eml':
    case 'html':
      return kind;
    default:
      return null;
  }
}

/** Plain words for what cannot be read yet. */
export function unreadableReason(kind: InboxKind): string {
  switch (kind) {
    case 'image':
      return 'Pictures cannot be read yet: describing a picture needs the vision model, which is not set up. The original is kept.';
    case 'audio':
    case 'video':
      return 'Recordings cannot be read yet: turning speech into text needs the transcription model, which is not set up. The original is kept.';
    case 'bundle':
      return 'This looks like a memory bundle from somewhere else. Importing a bundle is not available yet.';
    default:
      return 'This kind of file cannot be read. Markdown, text, CSV, PDF, Word, PowerPoint, Excel and email files can.';
  }
}

/** A text that is only a web address: filed as a link, and the page is never fetched. */
export function linkOnly(text: string): string | null {
  const t = text.trim();
  if (t.length > 2048 || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A short, safe slug for a file name: lowercase letters, digits and dashes, at most `max` characters; never empty. */
export function slugOf(name: string, max = 60): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const slug = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}
