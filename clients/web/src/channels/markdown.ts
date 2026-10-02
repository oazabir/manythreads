/*
 * A small, safe markdown reader for messages (PLAN P3-13). It turns text into a tree of plain data; `MessageMarkdown.tsx` draws the
 * tree with React elements, so nothing here or there ever produces HTML from message text: `<script>` stays the visible
 * characters `<script>`. Supported: paragraphs (a single newline is a line break, as in chat), fenced and inline code,
 * **bold**, *italic*, ~~strike~~, links, bare http(s) addresses, bullet and numbered lists, quotes, headings, @mentions and #channels.
 * Link targets are http, https, mailto or a same-site path; anything else (`javascript:`, `data:`) is shown as text.
 * Every scan is bounded (a closing mark must be within 500 characters; a paragraph over 4,000 characters is read as plain
 * text) so hostile input cannot make it slow (see test/markdown.test.ts).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'mention'; handle: string }
  | { t: 'channel'; name: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] };

const MAX_SPAN = 500;
const MAX_PARAGRAPH = 4_000;
const MAX_DEPTH = 4;

/** The href to use for a link target, or null when it is not one of the allowed kinds. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (href === '' || href.length > 2_048 || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  if (href.startsWith('/')) return href.startsWith('//') || href.startsWith('/\\') ? null : href;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  if (scheme === 'http' || scheme === 'https') return /^[a-z]+:\/\/[^/?#\s]+/i.test(href) ? href : null;
  if (scheme === 'mailto') return href.length > 7 ? href : null;
  return null;
}

const WORD = /[\p{L}\p{N}]/u;
const BARE_URL = /^https?:\/\/[^\s<>`]+/i;
const MENTION = /^@([\p{L}\p{N}](?:[\p{L}\p{N}_.-]{0,62}[\p{L}\p{N}])?)/u;
const CHANNEL = /^#([\p{L}\p{N}](?:[\p{L}\p{N}_-]{0,62}[\p{L}\p{N}])?)/u;

function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] ?? '';
    if ('.,;:!?\'"*~'.includes(last)) end -= 1;
    else if (last === ')' && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

function closer(text: string, from: number, mark: string): number {
  const at = text.indexOf(mark, from);
  return at === -1 || at - from > MAX_SPAN ? -1 : at;
}

export function parseInline(text: string, depth = 0): Inline[] {
  if (depth === 0 && text.length > MAX_PARAGRAPH) return [{ t: 'text', v: text }];
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const prev = i > 0 ? (text[i - 1] ?? '') : '';
    const rest = text.slice(i, i + MAX_SPAN + 2);

    if (ch === '\\' && i + 1 < text.length && /[\\`*_~[\]()#@>-]/.test(text[i + 1] ?? '')) {
      buf += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }
    if (ch === '`') {
      const end = closer(text, i + 1, '`');
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (ch === '*' || ch === '_' || ch === '~')) {
      const mark = rest.startsWith(ch + ch) ? ch + ch : ch;
      const innerStart = i + mark.length;
      const okOpen = !/\s/.test(text[innerStart] ?? ' ') && (ch !== '_' || !WORD.test(prev));
      const end = okOpen ? closer(text, innerStart, mark) : -1;
      const okClose = end > innerStart && !/\s/.test(text[end - 1] ?? ' ') && (ch !== '_' || !WORD.test(text[end + mark.length] ?? ''));
      if (okClose && !(ch === '~' && mark === '~')) {
        flush();
        const c = parseInline(text.slice(innerStart, end), depth + 1);
        out.push(ch === '~' ? { t: 'del', c } : mark.length === 2 ? { t: 'strong', c } : { t: 'em', c });
        i = end + mark.length;
        continue;
      }
    }
    if (ch === '[' && depth < MAX_DEPTH) {
      const close = closer(text, i + 1, '](');
      const endParen = close === -1 ? -1 : closer(text, close + 2, ')');
      if (close > i + 1 && endParen > close + 2 && !text.slice(i + 1, close).includes('\n')) {
        const href = safeHref(text.slice(close + 2, endParen));
        const label = text.slice(i + 1, close);
        flush();
        if (href) out.push({ t: 'link', href, c: parseInline(label, depth + 1) });
        else out.push({ t: 'text', v: label });
        i = endParen + 1;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !WORD.test(prev)) {
      const m = BARE_URL.exec(rest);
      if (m) {
        const url = trimUrl(m[0]);
        const href = safeHref(url);
        if (href && url.length > 8) {
          flush();
          out.push({ t: 'link', href, c: [{ t: 'text', v: url }] });
          i += url.length;
          continue;
        }
      }
    }
    if (ch === '@' && !WORD.test(prev) && prev !== '@') {
      const m = MENTION.exec(rest);
      if (m?.[1]) {
        flush();
        out.push({ t: 'mention', handle: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '#' && !WORD.test(prev) && prev !== '#') {
      const m = CHANNEL.exec(rest);
      if (m?.[1]) {
        flush();
        out.push({ t: 'channel', name: m[1] });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]{0,30})[^\n]*$/;
const BULLET = /^ {0,3}[-*+] +(.*)$/;
const NUMBERED = /^ {0,3}\d{1,9}[.)] +(.*)$/;
const HEADING = /^ {0,3}(#{1,6}) +(.*?)\s*#*\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    const text = para.join('\n');
    para = [];
    blocks.push({ t: 'p', c: parseInline(text) });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence?.[1]) {
      flushPara();
      const mark = fence[1];
      const body: string[] = [];
      const closing = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
      i += 1;
      while (i < lines.length && !closing.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      flushPara();
      blocks.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2] ?? '') });
      continue;
    }
    if (QUOTE.test(line) && depth < 2) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        inner.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '');
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'quote', c: parseMarkdown(inner.join('\n'), depth + 1) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = numbered !== null;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = pattern.exec(lines[i] ?? '');
        if (!m) break;
        items.push(parseInline(m[1] ?? ''));
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}
