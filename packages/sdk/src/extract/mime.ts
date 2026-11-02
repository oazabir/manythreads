import { extractHtml, type ExtractLimits } from './core.ts';
import { ExtractError, finishResult, type ExtractChild, type ExtractResult } from './types.ts';

// An email (`.eml`, RFC 5322 with MIME) read as text (PLAN P8-16, SPEC §12.2): the headers that matter, the body as text, each attachment as a child file for
// the caller to make an item of its own. Tracking pixels (inline pictures with no file name) and scripts (HTML is read through the same reader that drops
// `<script>`, `<style>` and every tag it does not print) are removed. Linear in the size of the message: a header block and each part are read once; the
// multipart tree is walked to a depth of 8 and 200 parts, so a message built to nest forever stops at the limit. Encoded words in headers and the three
// transfer encodings (base64, quoted-printable, 7/8-bit) are decoded; an unknown character set is read as UTF-8.

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADERS = 300;
const MAX_DEPTH = 8;
const MAX_PARTS = 200;
export const MAX_CHILDREN = 20;
const KEPT_HEADERS = ['from', 'to', 'cc', 'reply-to', 'date', 'subject', 'message-id', 'authentication-results', 'received-spf'];

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Splits a message or part at its first blank line. */
function splitHeadBody(src: string): { head: string; body: string } {
  const crlf = src.indexOf('\r\n\r\n');
  const lf = src.indexOf('\n\n');
  let at = -1;
  let gap = 0;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    at = crlf;
    gap = 4;
  } else if (lf !== -1) {
    at = lf;
    gap = 2;
  }
  if (at === -1) return { head: src.slice(0, MAX_HEADER_BYTES), body: '' };
  return { head: src.slice(0, Math.min(at, MAX_HEADER_BYTES)), body: src.slice(at + gap) };
}

/** Header lines unfolded (a line that starts with a blank continues the one before), names lower-cased; the first of each name wins. */
function parseHeaders(head: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let value = '';
  let count = 0;
  const commit = (): void => {
    if (name !== null && !out.has(name)) out.set(name, value.trim());
    name = null;
    value = '';
  };
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^[ \t]/.test(line) && name !== null) {
      if (value.length < 8_000) value += ` ${line.trim()}`;
      continue;
    }
    commit();
    const colon = line.indexOf(':');
    if (colon <= 0 || colon > 80) continue;
    if (++count > MAX_HEADERS) break;
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  commit();
  return out;
}

/** Encoded words (`=?utf-8?B?...?=` and `?Q?`) in a header value. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]{1,40})\?([bBqQ])\?([^?\s]{1,4000})\?=/g, (whole, charset: string, enc: string, data: string) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : quotedPrintableBytes(data.replace(/_/g, ' '));
      return decodeCharset(bytes, charset.split('*')[0]);
    } catch {
      return whole;
    }
  });
}

function quotedPrintableBytes(src: string): Uint8Array {
  const out: number[] = [];
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 61 /* = */) {
      if (src.charCodeAt(i + 1) === 13 && src.charCodeAt(i + 2) === 10) {
        i += 2;
        continue;
      }
      if (src.charCodeAt(i + 1) === 10) {
        i += 1;
        continue;
      }
      const hex = src.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (c < 256) out.push(c);
    else for (const b of Buffer.from(src.charAt(i), 'utf8')) out.push(b);
  }
  return Uint8Array.from(out);
}

interface Param {
  value: string;
  params: Map<string, string>;
}

/** `text/plain; charset="utf-8"; name=x` -> value and parameters (names lower-cased, quotes removed, RFC 2231 `name*=utf-8''...` decoded). */
function parseParams(raw: string | undefined): Param {
  const result: Param = { value: '', params: new Map() };
  if (!raw) return result;
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
    if (parts.length > 40) break;
  }
  parts.push(cur);
  result.value = (parts[0] ?? '').trim().toLowerCase();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    if (key.endsWith('*')) {
      key = key.slice(0, -1);
      const m = /^([^']*)'[^']*'(.*)$/.exec(val);
      if (m) {
        const bytes: number[] = [];
        const enc = m[2] ?? '';
        for (let i = 0; i < enc.length && bytes.length < 1_000; i++) {
          const hex = enc.charAt(i) === '%' ? enc.slice(i + 1, i + 3) : '';
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            bytes.push(Number.parseInt(hex, 16));
            i += 2;
          } else bytes.push(enc.charCodeAt(i) & 0xff);
        }
        val = decodeCharset(Uint8Array.from(bytes), m[1] || 'utf-8');
      }
    }
    if (!result.params.has(key)) result.params.set(key, decodeEncodedWords(val));
  }
  return result;
}

function transferDecode(body: string, encoding: string | undefined): Uint8Array {
  const e = (encoding ?? '7bit').trim().toLowerCase();
  if (e === 'base64') return Uint8Array.from(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  if (e === 'quoted-printable') return quotedPrintableBytes(body);
  return Uint8Array.from(Buffer.from(body, 'latin1'));
}

// eslint-disable-next-line no-control-regex
const cleanText = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

/** The pieces of a multipart body between `--boundary` lines. One pass with indexOf. */
function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let pos = 0;
  let start = -1;
  for (;;) {
    const at = body.indexOf(marker, pos);
    if (at === -1) break;
    // the marker must start a line
    if (at > 0 && body.charAt(at - 1) !== '\n') {
      pos = at + marker.length;
      continue;
    }
    if (start !== -1) parts.push(body.slice(start, Math.max(start, at - 1)).replace(/\r$/, ''));
    const after = at + marker.length;
    if (body.startsWith('--', after)) return parts;
    const eol = body.indexOf('\n', after);
    if (eol === -1) return parts;
    start = eol + 1;
    pos = start;
    if (parts.length >= MAX_PARTS) return parts;
  }
  if (start !== -1) parts.push(body.slice(start));
  return parts;
}

interface Walk {
  plain: string[];
  html: string[];
  children: ExtractChild[];
  parts: number;
  limits: ExtractLimits;
  droppedAttachments: number;
}

function walk(src: string, depth: number, w: Walk): { plain: string[]; html: string[] } {
  const local = { plain: [] as string[], html: [] as string[] };
  if (++w.parts > MAX_PARTS || depth > MAX_DEPTH) return local;
  const { head, body } = splitHeadBody(src);
  const h = parseHeaders(head);
  const type = parseParams(h.get('content-type'));
  const mime = type.value || 'text/plain';
  const disposition = parseParams(h.get('content-disposition'));
  const filename = disposition.params.get('filename') ?? type.params.get('name') ?? null;

  if (mime.startsWith('multipart/')) {
    const boundary = type.params.get('boundary');
    if (!boundary || boundary.length > 200) return local;
    const alternative = mime === 'multipart/alternative';
    const kids = splitMultipart(body, boundary);
    const pieces: Array<{ plain: string[]; html: string[] }> = [];
    for (const kid of kids) pieces.push(walk(kid, depth + 1, w));
    if (alternative) {
      // one reading of the same content: the plain one when there is one, else the HTML one
      const plain = pieces.flatMap((p) => p.plain);
      if (plain.length > 0) local.plain.push(...plain);
      else local.html.push(...pieces.flatMap((p) => p.html));
    } else {
      for (const p of pieces) {
        local.plain.push(...p.plain);
        local.html.push(...p.html);
      }
    }
    return local;
  }

  const encoding = h.get('content-transfer-encoding');
  const isAttachment = disposition.value === 'attachment' || (filename !== null && !mime.startsWith('text/')) || mime === 'message/rfc822' || (filename !== null && disposition.value !== 'inline');
  if (isAttachment) {
    // a forwarded message keeps its own headers: its raw text is the attachment
    const bytes = mime === 'message/rfc822' ? Uint8Array.from(Buffer.from(body, 'latin1')) : transferDecode(body, encoding);
    if (bytes.length > 0 && w.children.length < MAX_CHILDREN) {
      w.children.push({ name: clip(filename ?? (mime === 'message/rfc822' ? 'forwarded.eml' : 'attachment'), 200), mime, bytes });
    } else if (bytes.length > 0) w.droppedAttachments += 1;
    return local;
  }
  if (mime.startsWith('image/')) return local; // an inline picture with no file name: a logo or a tracking pixel
  if (mime === 'text/plain' || mime === 'text/html') {
    const text = decodeCharset(transferDecode(body, encoding), type.params.get('charset'));
    if (mime === 'text/plain') local.plain.push(text);
    else local.html.push(text);
    return local;
  }
  return local;
}

export function extractEml(bytes: Uint8Array, limits: ExtractLimits): ExtractResult {
  // a message is 7-bit text with the occasional 8-bit byte: read as latin1 so every byte keeps its value, then each part is decoded with its own charset
  const src = Buffer.from(bytes).toString('latin1');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,60}:/m.test(src.slice(0, 2048))) throw new ExtractError('This file is not an email message.');
  const { head } = splitHeadBody(src);
  const headers = parseHeaders(head);
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = headers.get(name);
    if (v !== undefined && v.length > 0) kept[name] = clip(cleanText(decodeEncodedWords(decodeLatin1AsUtf8(v))), name === 'authentication-results' ? 600 : 300);
  }
  const w: Walk = { plain: [], html: [], children: [], parts: 0, limits, droppedAttachments: 0 };
  const top = walk(src, 0, w);
  let body = top.plain.map(cleanText).join('\n\n').trim();
  if (body.length === 0 && top.html.length > 0) {
    const html = top.html.join('\n\n');
    try {
      body = extractHtml(new TextEncoder().encode(html), limits).text.trim();
    } catch {
      body = '';
    }
  }
  const lines: string[] = [];
  for (const [label, key] of [
    ['From', 'from'],
    ['To', 'to'],
    ['Cc', 'cc'],
    ['Date', 'date'],
    ['Subject', 'subject'],
  ] as const) {
    if (kept[key]) lines.push(`${label}: ${kept[key]}`);
  }
  let text = `${lines.join('\n')}\n\n${body}`.trim();
  let truncated = false;
  if (text.length > limits.maxChars) {
    text = text.slice(0, limits.maxChars);
    truncated = true;
  }
  if (w.droppedAttachments > 0) truncated = true;
  if (body.length === 0 && w.children.length === 0) throw new ExtractError('No text was found in this email.');
  // an email that is only attachments still has its headers as text
  return finishResult(text, [], kept['subject'] ?? null, truncated, { headers: kept }, w.children);
}

/** A header value read as latin1 may hold UTF-8 bytes (a mail program that skipped the encoding): when the bytes are valid UTF-8, read them so. */
function decodeLatin1AsUtf8(v: string): string {
  if (!/[\u0080-ÿ]/.test(v)) return v;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(Buffer.from(v, 'latin1')));
  } catch {
    return v;
  }
}
