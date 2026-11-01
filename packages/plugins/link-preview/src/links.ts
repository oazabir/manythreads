import { LINK_PREVIEW_MAX_PER_MESSAGE, normalizeEgressHost, parseMarkup } from '@manythreads/shared';
import { isIP } from 'node:net';

// Which links of a message get a card, and which sites the workspace allows. Pure; the same input always gives the same answer.

const MAX_URL_LENGTH = 2000;
/** Only this many `url` spans of a message are looked at, so a message that is one long list of links costs a bounded amount. */
const MAX_CANDIDATES = 50;
const HTTP_URL = /https?:\/\/[^\s<>"'`]+/i;

/** Takes a trailing sentence mark or an unbalanced bracket off a link found in running text ("see https://a.example/x)." -> "https://a.example/x"). */
function trimLink(url: string): string {
  // running counts, so each character is looked at a constant number of times (a link that is a long run of `)` must not cost a count per character)
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

/**
 * The address a link stands for, cleaned for reading and for storing: http or https, no user name or password (dropped, so a secret typed into a link is
 * not kept in a card), no `#fragment`, port 80 or 443 only, a host with a dot or a public-looking address literal. Null when it is none of that.
 */
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
  if (host === '' || (isIP(host) === 0 && !host.includes('.'))) return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  const href = url.href;
  return href.length <= MAX_URL_LENGTH ? href : null;
}

/**
 * The links of a message body that may get a card: the addresses written as bare links or as the target of `[label](address)`, outside code spans and
 * code blocks, in the order written, without repeats, at most `LINK_PREVIEW_MAX_PER_MESSAGE`. Linear in the text (the markup parser is).
 */
export function extractLinks(body: string): string[] {
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

/** True when `host` is `entry` or a subdomain of it. Both are lower-case host names. */
export const hostMatches = (host: string, entry: string): boolean => host === entry || host.endsWith(`.${entry}`);

export interface HostRules {
  enabled: boolean;
  allow: readonly string[];
  deny: readonly string[];
}

export const DEFAULT_RULES: HostRules = { enabled: true, allow: [], deny: [] };

/** Why a host may not be read, or null when the workspace's rules allow it. `deny` wins; a non-empty `allow` closes everything it does not list. */
export function refusedByRules(rules: HostRules, rawHost: string): 'off' | 'denied' | 'not_allowed' | null {
  if (!rules.enabled) return 'off';
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (rules.deny.some((entry) => hostMatches(host, entry))) return 'denied';
  if (rules.allow.length > 0 && !rules.allow.some((entry) => hostMatches(host, entry))) return 'not_allowed';
  return null;
}

/** Cleans an admin's list: each entry becomes a plain host name (a pasted address loses its scheme and path), repeats go, order is sorted. Null names the first bad entry. */
export function cleanHostList(entries: readonly string[]): { hosts: string[] } | { bad: string } {
  const hosts = new Set<string>();
  for (const raw of entries) {
    const host = normalizeEgressHost(raw);
    if (host === null) return { bad: raw };
    hosts.add(host);
  }
  return { hosts: [...hosts].sort() };
}
