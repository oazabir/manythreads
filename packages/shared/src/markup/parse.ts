import { findCodeRanges } from './code.ts';
import type {
  MarkupChannelRef,
  MarkupEntityRef,
  MarkupEntityType,
  MarkupMention,
  MarkupParseResult,
  MarkupToken,
  MarkupTokenType,
} from './schema.ts';

export interface ParseMarkupOptions {
  /**
   * Handles (without `@`, compared case-insensitively) that belong to bots. The text alone cannot tell `@nadia` from
   * `@coder`: the caller (server: the team roster; composer: its autocomplete list) says which handles are bots.
   */
  botHandles?: Iterable<string>;
}

const MAX_NAME = 64;
const LETTER = /\p{L}/u;

// A mention or channel must start a word: not glued to a letter/digit/mark (an email address, `a#b`), an escape (`\@`),
// a path or scope (`/@x`), an entity (`&#`), another `@`/`#`, or a dot (`a.@b`). The name ends on a letter/digit, so
// trailing punctuation (`@omar.`, `@omar,`, `#dev-`) stays outside, and it must not run into `/`, `@` or `\` (`@scope/pkg`).
const MENTION = /(?<![\p{L}\p{N}\p{M}\\@/&#.])@([\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_.-]*[\p{L}\p{N}\p{M}])?)(?![\p{L}\p{N}\p{M}@/\\])/gu;
const CHANNEL = /(?<![\p{L}\p{N}\p{M}\\@/&#.])#([\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}])?)(?![\p{L}\p{N}\p{M}#/\\])/gu;

const ENTITY = /(?<!\\)\[\[(thread|file|page|task):([^[\]\n|]{1,512})\]\]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Link destinations `](...)` and bare URLs: inert, their `@` and `#` are not mentions.
const LINK_DEST = /\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const URL = /(?:\b(?:https?|ftp|mailto):|\bwww\.)[^\s<>`]+/gi;

function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && '.,;:!?\'"*~'.includes(last)) end--;
    else if (last === ')' && count(url.slice(0, end), '(') < count(url.slice(0, end), ')')) end--;
    else if (last === ']' && count(url.slice(0, end), '[') < count(url.slice(0, end), ']')) end--;
    else break;
  }
  return url.slice(0, end);
}
const count = (s: string, ch: string): number => s.split(ch).length - 1;

/** `[[page:path]]` ids: a repo-relative path with no empty, `.` or `..` segments, no backslash, no control characters. */
function pagePath(raw: string): string | null {
  const path = raw.trim().replace(/^\/+/, '');
  if (path === '' || path.length > 512 || path.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? path : null;
}

function entityId(type: MarkupEntityType, raw: string): string | null {
  const value = raw.trim();
  if (type === 'page') return pagePath(raw);
  if (type === 'task') return TASK_ID.test(value) ? value : null;
  return UUID.test(value) ? value.toLowerCase() : null;
}

interface Claimed {
  type: MarkupTokenType;
  start: number;
  end: number;
}

/**
 * Parses what the composer and the server share in a message body: `@person`, `@bot`, `#channel` and
 * `[[thread:<uuid>]]` / `[[file:<uuid>]]` / `[[page:path]]` / `[[task:<id>]]`. Anything inside a code span, a code
 * fence, a link destination or a URL is ignored, as are email addresses and escaped (`\@x`) tokens. Offsets are UTF-16
 * indices into `markdown`. Never throws.
 */
export function parseMarkup(markdown: string, options: ParseMarkupOptions = {}): MarkupParseResult {
  const bots = new Set([...(options.botHandles ?? [])].map((h) => h.toLowerCase()));
  const claimed: Claimed[] = [];
  const free = (start: number, end: number): boolean => !claimed.some((c) => start < c.end && end > c.start);
  const claim = (type: MarkupTokenType, start: number, end: number): boolean => {
    if (!free(start, end)) return false;
    claimed.push({ type, start, end });
    return true;
  };

  for (const code of findCodeRanges(markdown)) claim(code.kind === 'fence' ? 'code_block' : 'code_span', code.start, code.end);
  const entityRefs: MarkupEntityRef[] = [];
  for (const m of markdown.matchAll(ENTITY)) {
    const type = m[1] as MarkupEntityType;
    const id = entityId(type, m[2] ?? '');
    if (id !== null && claim('entity_ref', m.index, m.index + m[0].length)) {
      entityRefs.push({ type, id, start: m.index, end: m.index + m[0].length });
    }
  }

  for (const m of markdown.matchAll(LINK_DEST)) {
    // keep the `]`: it belongs to the link text
    claim('url', m.index + 1, m.index + m[0].length);
  }
  for (const m of markdown.matchAll(URL)) claim('url', m.index, m.index + trimUrl(m[0]).length);

  const mentions: MarkupMention[] = [];
  for (const m of markdown.matchAll(MENTION)) {
    const handle = m[1] as string;
    if (handle.length > MAX_NAME || !claim('mention', m.index, m.index + 1 + handle.length)) continue;
    mentions.push({ kind: bots.has(handle.toLowerCase()) ? 'bot' : 'person', handle, start: m.index, end: m.index + 1 + handle.length });
  }

  const channels: MarkupChannelRef[] = [];
  for (const m of markdown.matchAll(CHANNEL)) {
    const name = m[1] as string;
    // `#123` is an issue number, not a channel.
    if (name.length > MAX_NAME || !LETTER.test(name) || !claim('channel', m.index, m.index + 1 + name.length)) continue;
    channels.push({ name, start: m.index, end: m.index + 1 + name.length });
  }

  claimed.sort((a, b) => a.start - b.start);
  const tokens: MarkupToken[] = [];
  let at = 0;
  for (const c of claimed) {
    if (c.start > at) tokens.push({ type: 'text', start: at, end: c.start });
    tokens.push({ type: c.type, start: c.start, end: c.end });
    at = c.end;
  }
  if (at < markdown.length) tokens.push({ type: 'text', start: at, end: markdown.length });

  const bySpan = <T extends { start: number }>(a: T, b: T): number => a.start - b.start;
  return { tokens, mentions: mentions.sort(bySpan), channels: channels.sort(bySpan), entityRefs: entityRefs.sort(bySpan) };
}
