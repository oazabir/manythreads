import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, MessageId, PollId } from '../ids.ts';

// Polls (PLAN P14-07, plugin `channels`). A poll is a message of a channel with a question and two to ten options; people who can read the channel
// vote, and the counts update live. The limits and the plain-text forms of a poll are shared so the browser, the server and a bot agree on them.

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;

/** A poll closes at least a minute from the moment the server reads the request, and at most a year ahead (the job that closes polls runs every minute). */
export const POLL_CLOSE_MIN_AHEAD_MS = 60_000;
export const POLL_CLOSE_MAX_AHEAD_MS = 365 * 24 * 3_600_000;
/** What the browser adds to a closing time it works out ("in 1 minute"), so the time is still a minute away when the request arrives. */
export const POLL_CLOSE_TRANSIT_MARGIN_MS = 15_000;

/**
 * An anonymous poll needs a channel with at least this many people who can read it. In a smaller group the live totals alone give a vote away
 * (two people, one count that moved), however well the ballots are hidden.
 */
export const POLL_ANONYMOUS_MIN_READERS = 5;
export const POLL_ANONYMOUS_TOO_SMALL = `An anonymous poll needs a channel that at least ${POLL_ANONYMOUS_MIN_READERS} people can read, and a direct message is too small. In a small group the totals moving would show who voted. Ask a public poll instead.`;

/** Text with a line break, a tab or another control character in it (they would forge lines in the poll message and in the result). */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const NO_CONTROL = { message: 'Write this on one line, without line breaks or other control characters' };

/**
 * The form an option is compared in, for "two options are the same": spaces collapsed and trimmed, capitals ignored. The database applies the same
 * rule (`lower(btrim(regexp_replace(o, '\s+', ' ', 'g')))`, migration 0014), so the browser and the server refuse the same pairs.
 */
export const pollOptionKey = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

export const PollQuestion = z
  .string()
  .trim()
  .min(1, 'Write the question')
  .max(POLL_QUESTION_MAX, `A question can have at most ${POLL_QUESTION_MAX} characters`)
  .refine((t) => !CONTROL.test(t), NO_CONTROL);
export type PollQuestion = z.infer<typeof PollQuestion>;

export const PollOptionText = z
  .string()
  .trim()
  .min(1, 'An option cannot be empty')
  .max(POLL_OPTION_MAX, `An option can have at most ${POLL_OPTION_MAX} characters`)
  .refine((t) => !CONTROL.test(t), NO_CONTROL);
export type PollOptionText = z.infer<typeof PollOptionText>;

/** The options as a list: two to ten, none written twice (capitals ignored). */
export const PollOptionList = z
  .array(PollOptionText)
  .min(POLL_MIN_OPTIONS, `A poll needs at least ${POLL_MIN_OPTIONS} options`)
  .max(POLL_MAX_OPTIONS, `A poll can have at most ${POLL_MAX_OPTIONS} options`)
  .refine((list) => new Set(list.map(pollOptionKey)).size === list.length, { message: 'Two options are the same' });
export type PollOptionList = z.infer<typeof PollOptionList>;

/** One option with the votes it has, in the order the author wrote them. The position in the list is the option's number (0 to 9) in a vote. */
export const PollOptionView = z.object({ text: PollOptionText, votes: z.number().int().nonnegative() });
export type PollOptionView = z.infer<typeof PollOptionView>;

/**
 * A poll as one reader sees it. `closed` is the effective state: true once the author closed it, and also once its closing time has passed (the
 * minute job records the closing a moment later; no vote is accepted after the time either way). `mine` is the options the reader chose (numbers
 * into `options`), empty when they have not voted. `voters` is how many people voted; with several choices allowed the option counts add up to more.
 * Nothing here says who voted for what: a named poll's voters come from the results route, an anonymous poll's from nowhere.
 */
export const PollView = z.object({
  id: PollId,
  question: PollQuestion,
  options: z.array(PollOptionView).min(POLL_MIN_OPTIONS).max(POLL_MAX_OPTIONS),
  anonymous: z.boolean(),
  multiple: z.boolean(),
  closesAt: IsoDateTime.nullable(),
  closed: z.boolean(),
  closedAt: IsoDateTime.nullable(),
  voters: z.number().int().nonnegative(),
  /** Goes up by one with every change of the poll (a vote, a withdrawal, the close). A page keeps the highest it has seen and ignores anything older. */
  version: z.number().int().nonnegative(),
  mine: z.array(z.number().int().min(0).max(POLL_MAX_OPTIONS - 1)),
  /** The message the minute job (or the author's early close) posted with the result; null while open, or when it could not be posted. */
  resultMessageId: MessageId.nullable(),
});
export type PollView = z.infer<typeof PollView>;

/** What is wrong with a closing time, in words for the person; the server and the dialog both say these. */
export const POLL_CLOSE_PAST = 'A poll must stay open for at least a minute. Choose a later time.';
export const POLL_CLOSE_FAR = 'A poll can stay open at most a year.';
export const POLL_CLOSE_BAD = 'That is not a time.';

export type ClosesAtCheck = { ok: true; at: Date } | { ok: false; reason: string };

/** Is this a closing time a poll may have, now? At least a minute away and within a year. */
export function checkClosesAt(at: Date | string, now: Date): ClosesAtCheck {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(t)) return { ok: false, reason: POLL_CLOSE_BAD };
  if (t < now.getTime() + POLL_CLOSE_MIN_AHEAD_MS) return { ok: false, reason: POLL_CLOSE_PAST };
  if (t > now.getTime() + POLL_CLOSE_MAX_AHEAD_MS) return { ok: false, reason: POLL_CLOSE_FAR };
  return { ok: true, at: new Date(t) };
}

/** The share of voters that chose an option, as a whole percent; 0 when nobody has voted. Several choices make the shares add up to more than 100. */
export function votePercent(votes: number, voters: number): number {
  if (voters <= 0 || votes <= 0) return 0;
  return Math.min(100, Math.round((votes / voters) * 100));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "No votes yet" / "1 vote" / "12 votes": the number of people who voted. */
export function votersText(voters: number): string {
  return voters === 0 ? 'No votes yet' : plural(voters, 'vote', 'votes');
}

/**
 * The text a poll message is stored with. The card replaces it on screen, but search, notifications and bots read this, so it holds the question,
 * the options and the rules in plain words.
 */
export function pollBodyText(p: { question: string; options: readonly string[]; multiple: boolean; anonymous: boolean; closesAt: string | null }): string {
  const lines = [`Poll: ${p.question}`, ...p.options.map((o, i) => `${i + 1}. ${o}`)];
  const rules = [p.multiple ? 'Choose one or more options' : 'Choose one option', p.anonymous ? 'votes are anonymous' : 'votes are public'];
  if (p.closesAt) rules.push(`closes ${p.closesAt}`);
  lines.push(`(${rules.join('; ')})`);
  return lines.join('\n');
}

/**
 * The plain message posted when a poll closes: the question, each option with its votes and share, and how many people voted. Plain lines, no
 * markup beyond what the options contained, so a bot reads it as it is. An anonymous poll's result is the same counts and nothing more.
 */
export function pollResultText(p: { question: string; options: readonly { text: string; votes: number }[]; voters: number; anonymous: boolean; closedEarly: boolean }): string {
  const lines = [`Poll closed${p.closedEarly ? ' early' : ''}: ${p.question}`];
  for (const o of p.options) lines.push(`${o.text}: ${plural(o.votes, 'vote', 'votes')} (${votePercent(o.votes, p.voters)}%)`);
  lines.push(p.voters === 0 ? 'Nobody voted.' : `${plural(p.voters, 'person', 'people')} voted${p.anonymous ? ' (anonymous poll)' : ''}.`);
  return lines.join('\n');
}

/** A voter of a named poll, with the options they chose. Only the results route of a named poll sends these. */
export const PollVoter = z.object({
  actorId: ActorId,
  displayName: z.string(),
  options: z.array(z.number().int().min(0).max(POLL_MAX_OPTIONS - 1)),
});
export type PollVoter = z.infer<typeof PollVoter>;
