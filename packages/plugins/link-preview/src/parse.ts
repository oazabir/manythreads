import { LINK_PREVIEW_DESCRIPTION_MAX, LINK_PREVIEW_SITE_MAX, LINK_PREVIEW_TITLE_MAX, type LinkPreviewImageType } from '@manythreads/shared';

// Reading what a page says about itself (Open Graph tags, Twitter-card tags, the <title>, and the oEmbed discovery link) from HTML that anybody wrote.
// The input is hostile: it can be a megabyte of unclosed tags, quotes that never end, `<script>` full of fake `<meta>` lines, entities that decode into
// markup. So the scanner is one forward pass (every `indexOf` and sticky regex only moves ahead, no backtracking over the same text twice), the
// result is plain text with lengths capped, and no markup of the page is ever kept.

export interface PageMeta {
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** The picture the page names, as an absolute http(s) address (not yet judged: the fetcher vets it like any other address). */
  image: string | null;
  /** The page's oEmbed endpoint (JSON), as an absolute http(s) address. */
  oembed: string | null;
}

export const EMPTY_META: PageMeta = { title: null, description: null, siteName: null, image: null, oembed: null };

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  euro: '€',
  pound: '£',
  times: '×',
};

const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi;

function fromCodePoint(n: number): string {
  // NUL, surrogates, the C1 controls and anything beyond Unicode become a space instead of a character that could confuse a reader
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) || (n >= 0x80 && n <= 0x9f)) return ' ';
  return String.fromCodePoint(n);
}

/** Decodes the character references of an attribute or a text node. One pass: `&amp;lt;` becomes `&lt;`, not `<`. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// controls, line/paragraph separators, bidirectional overrides and isolates, zero-width characters, the byte-order mark
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Plain, single-line text for a card: references decoded, invisible and direction-changing characters removed, blanks collapsed, cut to `max` characters. */
export function cleanText(raw: string | null | undefined, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const collapsed = decodeEntities(raw).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  if (collapsed.length <= max) return collapsed;
  // cut on a whole character: never leave half of a surrogate pair
  let end = max - 1;
  const code = collapsed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${collapsed.slice(0, end).trimEnd()}…`;
}

/** An http(s) address from a page's attribute, made absolute against `base`; null for anything else (`javascript:`, `data:`, a relative path that cannot resolve). */
export function resolveHttpUrl(raw: string | null | undefined, base: URL): string | null {
  if (!raw) return null;
  const trimmed = decodeEntities(raw).trim();
  if (trimmed === '' || trimmed.length > 2000) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Picks the character set: the HTTP header, a byte-order mark, a `<meta charset>` near the top, else UTF-8. An unknown name is UTF-8 too. */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  let label: string | null = null;
  const header = contentType ? /charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(contentType) : null;
  if (header?.[1]) label = header[1];
  if (!label) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
    else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  }
  if (!label) {
    const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
    const meta = /<meta[^>]{0,200}?charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(head);
    if (meta?.[1]) label = meta[1];
  }
  try {
    return new TextDecoder(label ?? 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'iframe', 'noembed', 'xmp', 'plaintext', 'template', 'noframes']);
const MAX_TAGS = 20_000;
const MAX_ATTRS = 48;
const MAX_ATTR_VALUE = 4000;

const closers = new Map<string, RegExp>();
/** A global, case-insensitive search for `</name` (the names come from RAW_TEXT, never from the page). */
function closerOf(name: string): RegExp {
  let re = closers.get(name);
  if (!re) {
    re = new RegExp(`</${name}`, 'gi');
    closers.set(name, re);
  }
  return re;
}

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

interface Tag {
  name: string;
  attrs: Map<string, string>;
  /** Offset just after the closing `>` (or the end of the text when the tag never closed). */
  end: number;
}

/** Reads one start tag whose `<` is at `start`; the name starts at `start + 1`. Linear in the tag's own length. */
function readTag(html: string, start: number): Tag {
  const n = html.length;
  let i = start + 1;
  while (i < n && isNameChar(html.charCodeAt(i))) i += 1;
  const name = html.slice(start + 1, i).toLowerCase();
  const attrs = new Map<string, string>();
  while (i < n) {
    const c = html.charCodeAt(i);
    if (c === 62) return { name, attrs, end: i + 1 }; // >
    if (isSpace(c) || c === 47) {
      i += 1;
      continue;
    }
    // attribute name: anything up to a blank, `=`, `>` or `/`
    const nameStart = i;
    while (i < n) {
      const d = html.charCodeAt(i);
      if (isSpace(d) || d === 61 || d === 62 || d === 47) break;
      i += 1;
    }
    const attr = html.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(html.charCodeAt(i))) i += 1;
    let value = '';
    if (i < n && html.charCodeAt(i) === 61) {
      i += 1;
      while (i < n && isSpace(html.charCodeAt(i))) i += 1;
      const q = html.charCodeAt(i);
      if (q === 34 || q === 39) {
        const close = html.indexOf(html[i] as string, i + 1);
        const stop = close < 0 ? n : close;
        value = html.slice(i + 1, Math.min(stop, i + 1 + MAX_ATTR_VALUE));
        i = close < 0 ? n : close + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i += 1;
        value = html.slice(valueStart, Math.min(i, valueStart + MAX_ATTR_VALUE));
      }
    }
    if (attr !== '' && attrs.size < MAX_ATTRS && !attrs.has(attr)) attrs.set(attr, value);
  }
  return { name, attrs, end: n };
}

/**
 * Reads the head of an HTML page: Open Graph (`og:`), Twitter-card (`twitter:`) and plain `description` meta tags, the `<title>`, the first `<base href>`
 * and the oEmbed discovery `<link>`. The scan stops at `<body`: meta tags below it are page content (a comment box can contain anything), not the
 * page's own description. `pageUrl` is where the page was read (after redirects) and resolves relative addresses.
 */
export function parseHtmlMeta(html: string, pageUrl: URL): PageMeta {
  const metas = new Map<string, string>();
  let titleTag: string | null = null;
  let base: URL = pageUrl;
  let baseSeen = false;
  let oembed: string | null = null;
  const n = html.length;
  let i = 0;
  let tags = 0;
  while (i < n && tags < MAX_TAGS) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt + 1 >= n) break;
    const next = html.charCodeAt(lt + 1);
    if (next === 33) {
      // <!-- comment --> or <!doctype ...>
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        if (end < 0) break;
        i = end + 3;
      } else {
        const end = html.indexOf('>', lt + 2);
        if (end < 0) break;
        i = end + 1;
      }
      continue;
    }
    if (next === 47 || next === 63) {
      // </end> or <?processing?>
      const end = html.indexOf('>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (!((next >= 97 && next <= 122) || (next >= 65 && next <= 90))) {
      i = lt + 1;
      continue;
    }
    tags += 1;
    const tag = readTag(html, lt);
    i = tag.end;
    if (tag.name === 'body') break;
    if (RAW_TEXT.has(tag.name)) {
      // the text up to the matching end tag is not markup (scripts and styles are full of strings that look like tags); one that never closes
      // swallows the rest of the page
      const closer = closerOf(tag.name);
      closer.lastIndex = i;
      const m = closer.exec(html);
      if (m === null) break;
      i = m.index;
      continue;
    }
    if (tag.name === 'title') {
      if (titleTag === null) {
        const end = html.indexOf('<', i);
        titleTag = html.slice(i, end < 0 ? n : Math.min(end, i + 2000));
      }
      continue;
    }
    if (tag.name === 'base') {
      if (!baseSeen) {
        baseSeen = true;
        const resolved = resolveHttpUrl(tag.attrs.get('href'), pageUrl);
        if (resolved) base = new URL(resolved);
      }
      continue;
    }
    if (tag.name === 'meta') {
      const key = (tag.attrs.get('property') ?? tag.attrs.get('name') ?? '').trim().toLowerCase();
      const content = tag.attrs.get('content');
      if (key !== '' && key.length <= 40 && content !== undefined && !metas.has(key)) metas.set(key, content);
      continue;
    }
    if (tag.name === 'link' && oembed === null) {
      const rel = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      const type = (tag.attrs.get('type') ?? '').trim().toLowerCase();
      if (rel.includes('alternate') && type === 'application/json+oembed') oembed = resolveHttpUrl(tag.attrs.get('href'), base);
    }
  }
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const v = metas.get(key);
      if (v !== undefined && v.trim() !== '') return v;
    }
    return null;
  };
  return {
    title: cleanText(pick('og:title', 'twitter:title') ?? titleTag, LINK_PREVIEW_TITLE_MAX),
    description: cleanText(pick('og:description', 'twitter:description', 'description'), LINK_PREVIEW_DESCRIPTION_MAX),
    siteName: cleanText(pick('og:site_name', 'application-name'), LINK_PREVIEW_SITE_MAX),
    image: resolveHttpUrl(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), base),
    oembed,
  };
}

/** What a page's oEmbed JSON adds. Only text and a thumbnail are read; the `html` member of a "rich" or "video" answer is never used. */
export function parseOembed(json: string, endpoint: URL): PageMeta {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return EMPTY_META;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY_META;
  const o = value as Record<string, unknown>;
  const text = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const author = cleanText(text('author_name'), LINK_PREVIEW_SITE_MAX);
  return {
    title: cleanText(text('title'), LINK_PREVIEW_TITLE_MAX),
    description: author,
    siteName: cleanText(text('provider_name'), LINK_PREVIEW_SITE_MAX),
    image: resolveHttpUrl(text('thumbnail_url'), endpoint),
    oembed: null,
  };
}

/** True when the page said anything a card could show. */
export const hasContent = (m: PageMeta): boolean => m.title !== null || m.description !== null || m.image !== null;

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

/**
 * The kind of picture the bytes really are, from their first bytes, or null. The type the site declared is never trusted: a page that calls itself
 * `image/png` is still an HTML page. SVG (which can carry script), HTML, ICO and everything else are not pictures here.
 */
export function sniffImage(bytes: Uint8Array): LinkPreviewImageType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

/** A picture wider or taller than this is not kept: a small file can still decode to a huge bitmap (a decompression bomb for the browser). */
export const IMAGE_MAX_SIDE = 4096;
/** ...and one with more pixels than this (16 million: 4096 x 4096). */
export const IMAGE_MAX_PIXELS = 16_000_000;

export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, at: number): number => ((b[at] as number) << 8) | (b[at + 1] as number);
const u16le = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u24le = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16);
// multiplications, not shifts: `<< 24` turns a value past 2^31 negative
const u32be = (b: Uint8Array, at: number): number => (b[at] as number) * 0x1000000 + (((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number));
const u32le = (b: Uint8Array, at: number): number => (b[at + 3] as number) * 0x1000000 + (((b[at + 2] as number) << 16) | ((b[at + 1] as number) << 8) | (b[at] as number));

/** The JPEG markers that start a frame and carry its size (all the start-of-frame markers except the table markers C4, C8 and CC). */
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): ImageSize[] {
  let i = 2;
  for (let segments = 0; segments < 4000 && i + 4 <= b.length; segments += 1) {
    if (b[i] !== 0xff) return [];
    let marker = b[i + 1] as number;
    while (marker === 0xff && i + 2 < b.length) {
      i += 1; // fill bytes
      marker = b[i + 1] as number;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return []; // the picture data starts and no frame header came first
    if (i + 4 > b.length) return [];
    const length = u16be(b, i + 2);
    if (length < 2) return [];
    if (JPEG_FRAME.has(marker)) {
      if (i + 9 > b.length) return [];
      return [{ height: u16be(b, i + 5), width: u16be(b, i + 7) }];
    }
    i += 2 + length;
  }
  return [];
}

function webpSize(b: Uint8Array): ImageSize[] {
  if (b.length < 30) return [];
  const kind = ascii(b, 12, 16);
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return [];
    return [{ width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }];
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return [];
    const bits = u32le(b, 21);
    return [{ width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) & 0x3fff) + 1 }];
  }
  if (kind === 'VP8X') return [{ width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }];
  return [];
}

/** AVIF is an ISO box file: the sizes are the `ispe` boxes inside meta > iprp > ipco. Every one found is returned, so a hidden big one is judged too. */
function avifSizes(b: Uint8Array): ImageSize[] {
  const out: ImageSize[] = [];
  let boxes = 0;
  const walk = (from: number, to: number, depth: number): void => {
    let at = from;
    while (at + 8 <= to && boxes < 400) {
      boxes += 1;
      let size = u32be(b, at);
      const type = ascii(b, at + 4, at + 8);
      let header = 8;
      if (size === 1) {
        if (at + 16 > to) return;
        size = u32be(b, at + 8) * 0x100000000 + u32be(b, at + 12);
        header = 16;
      } else if (size === 0) size = to - at;
      if (size < header || at + size > to) return;
      const end = at + size;
      if (type === 'ispe' && end - at >= header + 12) out.push({ width: u32be(b, at + header + 4), height: u32be(b, at + header + 8) });
      else if (depth < 4 && (type === 'iprp' || type === 'ipco')) walk(at + header, end, depth + 1);
      else if (depth < 4 && type === 'meta') walk(at + header + 4, end, depth + 1); // meta is a "full box": four bytes of version and flags first
      at = end;
    }
  };
  walk(0, b.length, 0);
  return out;
}

/**
 * The sizes a picture declares in its own header, read without decoding it: one for most kinds, every `ispe` for AVIF, an empty list when the header is
 * not where it should be. `type` is what `sniffImage` said the bytes are.
 */
export function imageSizes(bytes: Uint8Array, type: LinkPreviewImageType): ImageSize[] {
  switch (type) {
    case 'image/png':
      return bytes.length >= 24 && ascii(bytes, 12, 16) === 'IHDR' ? [{ width: u32be(bytes, 16), height: u32be(bytes, 20) }] : [];
    case 'image/gif':
      return bytes.length >= 10 ? [{ width: u16le(bytes, 6), height: u16le(bytes, 8) }] : [];
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/webp':
      return webpSize(bytes);
    case 'image/avif':
      return avifSizes(bytes);
  }
}

/** True when the picture declares a size we are willing to keep: it could be read, is not empty, and is within both limits. A size that cannot be read is a no. */
export function imageSizeAllowed(bytes: Uint8Array, type: LinkPreviewImageType): boolean {
  const sizes = imageSizes(bytes, type);
  if (sizes.length === 0) return false;
  return sizes.every((s) => s.width >= 1 && s.height >= 1 && s.width <= IMAGE_MAX_SIDE && s.height <= IMAGE_MAX_SIDE && s.width * s.height <= IMAGE_MAX_PIXELS);
}
