/** Image types the browser may show inline from a download link. Only when the first bytes agree with the type (see `sniffMime`). */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

/** Types a browser would run or render with the page's authority: always served as opaque bytes, whatever was declared. */
const ACTIVE_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/css',
]);

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, text: string): boolean => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** What the first bytes say the file is, for the formats people attach; undefined when they say nothing we know. */
export function sniffMime(head: Uint8Array): string | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'image/gif';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image/webp';
  if (ascii(head, 0, 'BM') && head.length >= 14) return 'image/bmp';
  if (ascii(head, 4, 'ftyp')) {
    if (ascii(head, 8, 'avif') || ascii(head, 8, 'avis')) return 'image/avif';
    if (ascii(head, 8, 'qt  ')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (ascii(head, 0, '%PDF-')) return 'application/pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(head, 0, 'ID3') || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(head, 0, 'OggS')) return 'audio/ogg';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'audio/wav';
  return undefined;
}

const TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The type to store. The bytes win over the header: a recognised signature decides. Otherwise the declared type is kept when it is a
 * well formed `type/subtype` (parameters dropped), except an image type the bytes do not confirm (a script dressed as `image/png`),
 * which becomes opaque bytes. Nothing declared means `application/octet-stream`.
 */
export function decideMime(declared: string | undefined, head: Uint8Array): string {
  const sniffed = sniffMime(head);
  const d = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const clean = TOKEN.test(d) ? d : undefined;
  if (sniffed) {
    // A zip may be an Office file or a jar: keep a declared specific zip-based type, not a conflicting one.
    if (sniffed === 'application/zip' && clean && /^application\/(vnd\.|epub|x-zip|java-archive|x-tar)/.test(clean)) return clean;
    return sniffed;
  }
  if (!clean) return 'application/octet-stream';
  if (clean.startsWith('image/') && clean !== 'image/svg+xml') return 'application/octet-stream';
  return clean;
}

/** What the download response says: stored types that run in a browser become opaque; everything else is as stored. */
export const servedMime = (stored: string): string => (ACTIVE_TYPES.has(stored) ? 'application/octet-stream' : stored);

/** `inline` only for an image the bytes confirmed at upload (it is stored as that type); everything else downloads. */
export const dispositionFor = (stored: string): 'inline' | 'attachment' => (INLINE_IMAGE_TYPES.has(stored) ? 'inline' : 'attachment');
