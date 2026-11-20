import { LINK_PREVIEW_MAX_PER_MESSAGE, parseMarkup } from '@manythreads/shared';

/*
 * One preview per link where people read a stretch of talk together (P34-04, docs/plans/everyday-screens.md findings 11-13 and correction 6): inside a
 * thread, a link an earlier message of the thread already carries gets no card on later messages; in a channel only inside one author's run (the
 * rows that share one header), never across authors and never across loaded pages. The later message keeps its plain link.
 *
 * The decision is made from the message texts, not from the cards: the texts are there when the row is drawn, so a row never shows a card that goes
 * away when the earlier message's cards arrive (rows must not move), and a card someone removed with × does not jump to the next mention. The links are
 * read as the link-preview plugin reads them (`packages/plugins/link-preview/src/links.ts`), so a link here is spelled as the card's `url`.
 */

const MAX_URL_LENGTH = 2000;
const MAX_CANDIDATES = 50;
const HTTP_URL = /https?:\/\/[^\s<>"'`]+/i;

/** Takes a trailing sentence mark or an unbalanced bracket off a link found in running text, as the server does. Linear: running bracket counts. */
function trimLink(url: string): string {
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  for (let i = 0; i < url.length; i += 1) {
    const c = url[i];
    if (c === '(') openParen += 1;
    else if (c === ')') closeParen += 1;
    else if (c === '[') openBracket += 1;
    else if (c === ']') closeBracket += 1;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] as string;
    if ('.,;:!?*~_'.includes(last)) end -= 1;
    else if (last === ')' && openParen < closeParen) {
      closeParen -= 1;
      end -= 1;
    } else if (last === ']' && openBracket < closeBracket) {
      closeBracket -= 1;
      end -= 1;
    } else break;
  }
  return url.slice(0, end);
}

/** The address as the server stores it on a card: http or https, no user name or password, no `#fragment`, port 80 or 443 only, a host with a dot or an address literal. */
export function normalizeLink(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH * 2) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || (!host.includes('.') && !host.includes(':'))) return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  const href = url.href;
  return href.length <= MAX_URL_LENGTH ? href : null;
}

/** The links of a message body that may get a card, in the order written, without repeats, outside code: the same list the server makes cards for. */
export function messageLinks(body: string): string[] {
  if (!/https?:\/\//i.test(body)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let looked = 0;
  for (const token of parseMarkup(body).tokens) {
    if (token.type !== 'url') continue;
    looked += 1;
    if (looked > MAX_CANDIDATES) break;
    const found = HTTP_URL.exec(body.slice(token.start, token.end));
    if (!found) continue;
    const link = normalizeLink(trimLink(found[0]));
    if (link === null || seen.has(link)) continue;
    seen.add(link);
    out.push(link);
    if (out.length >= LINK_PREVIEW_MAX_PER_MESSAGE) break;
  }
  return out;
}

type Linked = { body: string; deletedAt: string | null };
/** Links by message object: a message is replaced, never changed in place, so a list rebuild does not parse every body again. */
const linksCache = new WeakMap<Linked, readonly string[]>();
/** The links of a message that can carry cards (a deleted message shows none). */
export function linksOf(m: Linked): readonly string[] {
  if (m.deletedAt !== null) return [];
  let links = linksCache.get(m);
  if (links === undefined) {
    links = messageLinks(m.body);
    linksCache.set(m, links);
  }
  return links;
}

/** The links shown above a message, as the one string a memoised row compares by value: links have no spaces, so they are joined by one. */
export type LinksAbove = string;
export const splitLinksAbove = (above: LinksAbove | undefined): ReadonlySet<string> => new Set(above ? above.split(' ') : []);

/**
 * For each message (oldest first), the links the earlier messages of its group carry. A group starts where `startsGroup(index)` is true; `seed` (a thread's
 * root) counts above every message.
 */
export function linksAboveEach(messages: readonly Linked[], startsGroup: (index: number) => boolean, seed: readonly string[] = []): LinksAbove[] {
  const out: LinksAbove[] = [];
  let seen = new Set(seed);
  messages.forEach((m, i) => {
    if (i > 0 && startsGroup(i)) seen = new Set(seed);
    out.push([...seen].join(' '));
    for (const l of linksOf(m)) seen.add(l);
  });
  return out;
}

/** In a thread: the root's links and every earlier reply's, except across a page of older replies loaded later (`pageStarts`, so loading them never hides a card already shown). */
export function threadLinksAbove(root: Linked | null, replies: readonly (Linked & { id: string })[], pageStarts: readonly string[] = []): LinksAbove[] {
  const starts = new Set(pageStarts);
  return linksAboveEach(replies, (i) => starts.has(replies[i]!.id), root ? linksOf(root) : []);
}

/** Every link the message has was shown above: it gets no card, keeps no room and asks for nothing. */
export const allShownAbove = (own: readonly string[], above: ReadonlySet<string>): boolean => above.size > 0 && own.length > 0 && own.every((l) => above.has(l));

/* A message with a new link next to a repeated one shows all its cards (LinkPreviewCards: a row never shrinks after it is drawn). */
