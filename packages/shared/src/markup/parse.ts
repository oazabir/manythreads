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
 * The claimed spans, kept sorted and disjoint. Each phase of the parser finds its candidates in ascending order, so one sweep over
 * the claimed list (two pointers) accepts the candidates that overlap nothing and one linear merge adds them: a phase costs
 * O(claimed + candidates), never "each candidate against every earlier claim" (13,000 mentions were 180 ms that way).
 */
function claimPhase<T extends { start: number; end: number }>(claimed: Claimed[], type: MarkupTokenType, candidates: readonly T[]): T[] {
  const accepted: T[] = [];
  let j = 0;
  let lastEnd = -1;
  for (const c of candidates) {
    while (j < claimed.length && (claimed[j] as Claimed).end <= c.start) j++;
    const hit = j < claimed.length && (claimed[j] as Claimed).start < c.end;
    if (hit || c.start < lastEnd) continue;
    accepted.push(c);
    lastEnd = c.end;
  }
  if (accepted.length === 0) return accepted;
  const merged: Claimed[] = [];
  let a = 0;
  let b = 0;
  while (a < claimed.length || b < accepted.length) {
    const next = accepted[b];
    if (next === undefined || (a < claimed.length && (claimed[a] as Claimed).start <= next.start)) merged.push(claimed[a++] as Claimed);
    else {
      merged.push({ type, start: next.start, end: next.end });
      b++;
    }
  }
  claimed.length = 0;
  for (const c of merged) claimed.push(c);
  return accepted;
}

/**
 * Parses what the composer and the server share in a message body: `@person`, `@bot`, `#channel` and
 * `[[thread:<uuid>]]` / `[[file:<uuid>]]` / `[[page:path]]` / `[[task:<id>]]`. Anything inside a code span, a code
 * fence, a link destination or a URL is ignored, as are email addresses and escaped (`\@x`) tokens. Offsets are UTF-16
 * indices into `markdown`. Never throws. Linear in the text (claims are checked with sorted-interval sweeps).
 */
export function parseMarkup(markdown: string, options: ParseMarkupOptions = {}): MarkupParseResult {
  const bots = new Set([...(options.botHandles ?? [])].map((h) => h.toLowerCase()));
  const claimed: Claimed[] = [];

  // Code ranges come sorted and disjoint, so they seed the claimed list as they are.
  for (const code of findCodeRanges(markdown)) claimed.push({ type: code.kind === 'fence' ? 'code_block' : 'code_span', start: code.start, end: code.end });

  const entityCandidates: MarkupEntityRef[] = [];
  for (const m of markdown.matchAll(ENTITY)) {
    const type = m[1] as MarkupEntityType;
    const id = entityId(type, m[2] ?? '');
    if (id !== null) entityCandidates.push({ type, id, start: m.index, end: m.index + m[0].length });
  }
  const entityRefs = claimPhase(claimed, 'entity_ref', entityCandidates);

  // keep the `]` of a link destination: it belongs to the link text
  claimPhase(
    claimed,
    'url',
    [...markdown.matchAll(LINK_DEST)].map((m) => ({ start: m.index + 1, end: m.index + m[0].length })),
  );
  claimPhase(
    claimed,
    'url',
    [...markdown.matchAll(URL)].map((m) => ({ start: m.index, end: m.index + trimUrl(m[0]).length })),
  );

  const mentionCandidates: MarkupMention[] = [];
  for (const m of markdown.matchAll(MENTION)) {
    const handle = m[1] as string;
    if (handle.length > MAX_NAME) continue;
    mentionCandidates.push({ kind: bots.has(handle.toLowerCase()) ? 'bot' : 'person', handle, start: m.index, end: m.index + 1 + handle.length });
  }
  const mentions = claimPhase(claimed, 'mention', mentionCandidates);

  const channelCandidates: MarkupChannelRef[] = [];
  for (const m of markdown.matchAll(CHANNEL)) {
    const name = m[1] as string;
    // `#123` is an issue number, not a channel.
    if (name.length > MAX_NAME || !LETTER.test(name)) continue;
    channelCandidates.push({ name, start: m.index, end: m.index + 1 + name.length });
  }
  const channels = claimPhase(claimed, 'channel', channelCandidates);

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
