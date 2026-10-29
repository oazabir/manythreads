import { z } from 'zod';
import type { ChannelKind } from './channel.ts';
import type { NotificationKind } from './notification.ts';

// How loud a channel is for one person, and the words a person wants to hear about (PLAN P14-09). Pure rules: the notifications plugin decides
// with them on the server and the settings screen shows the same words in the browser, so both sides agree on what "mentions only" means.

/**
 * What a channel may interrupt a person with:
 * - `all`: every message by someone else;
 * - `mentions`: only being named, one of their keywords, and replies in threads they follow (direct messages count as being named only when the
 *   person turned `all` off for that conversation);
 * - `nothing`: nothing at all, a mention included.
 */
export const NotificationLevel = z.enum(['all', 'mentions', 'nothing']);
export type NotificationLevel = z.infer<typeof NotificationLevel>;

export const NOTIFICATION_LEVELS: readonly NotificationLevel[] = NotificationLevel.options;

/** What a workspace starts with: mentions and keywords only, so a busy channel does not buzz anyone until they ask it to. */
export const DEFAULT_WORKSPACE_LEVEL: NotificationLevel = 'mentions';

/** The level of a channel nobody has set: a direct message always tells (that is what it is for); a channel follows the workspace's default. */
export function defaultLevelFor(channelKind: ChannelKind | string, workspaceDefault: NotificationLevel): NotificationLevel {
  return channelKind === 'dm' ? 'all' : workspaceDefault;
}

/** The level that applies: the person's own choice for this channel, else the default for its kind. */
export function effectiveLevel(own: NotificationLevel | null | undefined, channelKind: ChannelKind | string, workspaceDefault: NotificationLevel): NotificationLevel {
  return own ?? defaultLevelFor(channelKind, workspaceDefault);
}

/**
 * May a notification of this kind be made at this level? `mention` includes a keyword; `reply` is a reply in a thread the person follows.
 * A direct message (`dm`) and a plain message (`message`) are "everything", so they need `all`.
 */
export function levelAllows(level: NotificationLevel, kind: NotificationKind): boolean {
  if (level === 'nothing') return false;
  if (level === 'all') return true;
  return kind === 'mention' || kind === 'reply';
}

/** Plain words for a level (the settings screen and the channel bell menu). */
export const LEVEL_LABEL: Record<NotificationLevel, string> = {
  all: 'All messages',
  mentions: 'Mentions and keywords only',
  nothing: 'Nothing',
};

// Keywords ------------------------------------------------------------------------------------------------------------------------

export const KEYWORD_MAX_COUNT = 20;
export const KEYWORD_MAX_LENGTH = 40;
export const KEYWORD_MAX_WORDS = 4;
/** A message longer than this is read only up to here, so a hostile one cannot make matching slow. */
const MATCH_TEXT_MAX = 20_000;
/** At most this many words of a message are looked at. */
export const MATCH_WORDS_MAX = 4_000;

const WORD = /[\p{L}\p{M}\p{N}_]+/gu;

/**
 * The words of a text, in lower case: runs of letters, digits and underscores (so `Deploy!` and `re-deploy` both hold `deploy`). One pass over
 * the text, no backtracking.
 */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  const lower = text.slice(0, MATCH_TEXT_MAX).normalize('NFKC').toLowerCase();
  for (const m of lower.matchAll(WORD)) {
    out.push(m[0]);
    if (out.length >= MATCH_WORDS_MAX) break;
  }
  return out;
}

/** Why a keyword was refused, in words for the person; null when it is fine. */
export type KeywordProblem = 'empty' | 'too_long' | 'too_many_words';

/** The stored form of a keyword: its words in lower case joined by single spaces; or why it cannot be used. */
export function normalizeKeyword(input: string): { keyword: string } | { problem: KeywordProblem } {
  if (input.length > KEYWORD_MAX_LENGTH * 2) return { problem: 'too_long' };
  const words = wordsOf(input);
  if (words.length === 0) return { problem: 'empty' };
  if (words.length > KEYWORD_MAX_WORDS) return { problem: 'too_many_words' };
  const keyword = words.join(' ');
  if (keyword.length > KEYWORD_MAX_LENGTH) return { problem: 'too_long' };
  return { keyword };
}

export const KEYWORD_PROBLEM_TEXT: Record<KeywordProblem, string> = {
  empty: 'A keyword needs at least one letter or digit.',
  too_long: `A keyword can be at most ${KEYWORD_MAX_LENGTH} characters.`,
  too_many_words: `A keyword can be at most ${KEYWORD_MAX_WORDS} words.`,
};

/** The first word of a stored keyword (the server narrows candidates by it before checking the whole phrase). */
export const firstWordOf = (keyword: string): string => keyword.split(' ', 1)[0] ?? keyword;

/**
 * Which of these stored keywords (`normalizeKeyword` form) are in the text as whole words, upper or lower case alike. `cat` is not in `category`
 * and is in `Cat!`; a phrase matches when its words follow one another. Linear in the text for a bounded number of keywords.
 */
export function matchKeywords(text: string, keywords: readonly string[]): string[] {
  if (keywords.length === 0) return [];
  const words = wordsOf(text);
  if (words.length === 0) return [];
  const found: string[] = [];
  for (const keyword of keywords) {
    const parts = keyword.split(' ');
    if (parts.length === 0 || parts[0] === '') continue;
    if (containsRun(words, parts)) found.push(keyword);
  }
  return found;
}

function containsRun(words: readonly string[], parts: readonly string[]): boolean {
  const first = parts[0];
  for (let i = 0; i + parts.length <= words.length; i += 1) {
    if (words[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < parts.length; j += 1) {
      if (words[i + j] !== parts[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
