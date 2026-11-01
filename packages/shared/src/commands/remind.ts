import { checkRemindAt } from '../entities/later.ts';
import { REMINDER_TEXT_MAX } from '../entities/reminder.ts';
import { WHEN_USAGE, parseWhen } from './when.ts';

/*
 * `/remind me|@person|#channel <when> <what>` (PLAN P14-04): who is reminded, when (read by `parseWhen`), and about what. Pure text rules, linear time:
 * the target is the first word, the time is read by the fixed grammar of when.ts, and the rest of the text is only sliced.
 */

export const REMIND_USAGE = 'Write who, when and what, for example /remind me in 20 minutes call the bank, or /remind #dev monday at 9 standup.';

export type RemindWho = { kind: 'me' } | { kind: 'person'; name: string } | { kind: 'channel'; name: string };

export type RemindArgs =
  /** `/remind` alone, or `/remind list`: show the reminders this person set. */
  | { kind: 'list' }
  | { kind: 'ok'; who: RemindWho; at: Date; text: string; phrase: string }
  | { kind: 'error'; reason: string };

const isNameChar = (ch: string): boolean => /[\p{L}\p{N}_.-]/u.test(ch);

/** A name after `@` or `#`: 1 to 40 letters, digits, `_`, `.` or `-`, and nothing after it but the end of the word. */
function readName(word: string): string | null {
  if (word.length < 2 || word.length > 41) return null;
  const name = word.slice(1);
  for (const ch of name) if (!isNameChar(ch)) return null;
  return name;
}

/** Reads what follows `/remind`. `now` and `timeZone` (an IANA name) are the clock of the page; the server checks the instant again. */
export function parseRemindArgs(args: string, now: Date, timeZone: string): RemindArgs {
  const text = args.trim();
  if (text === '' || text.toLowerCase() === 'list') return { kind: 'list' };
  let end = 0;
  while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1;
  const word = text.slice(0, end);
  let who: RemindWho;
  if (word.toLowerCase() === 'me') who = { kind: 'me' };
  else if (word.startsWith('@') || word.startsWith('#')) {
    const name = readName(word);
    if (name === null) return { kind: 'error', reason: `“${word.slice(0, 42)}” is not a name I can read. ${REMIND_USAGE}` };
    who = word.startsWith('@') ? { kind: 'person', name } : { kind: 'channel', name };
  } else {
    return { kind: 'error', reason: `Say who to remind: me, @person or #channel. ${REMIND_USAGE}` };
  }
  const rest = text.slice(end).trim();
  if (rest === '') return { kind: 'error', reason: WHEN_USAGE };
  const when = parseWhen(rest, now, timeZone);
  if (!when.ok) return { kind: 'error', reason: when.reason };
  const what = when.rest.replace(/\s+/g, ' ').trim();
  if (what === '') return { kind: 'error', reason: 'Say what to be reminded of after the time, for example /remind me tomorrow at 9 send the report.' };
  if ([...what].length > REMINDER_TEXT_MAX) return { kind: 'error', reason: `A reminder can have at most ${REMINDER_TEXT_MAX} characters. This one has ${[...what].length}.` };
  const check = checkRemindAt(when.at, now);
  if (!check.ok) return { kind: 'error', reason: check.reason };
  return { kind: 'ok', who, at: check.at, text: what, phrase: when.phrase };
}

/**
 * The text as a code span, so that what a person wrote for someone else is shown as plain words: inside a code span nothing is a link, a mention or
 * emphasis, and the link-preview plugin does not read it. The delimiter is one backtick longer than the longest run of backticks inside the text, and a
 * text that starts or ends with a backtick gets a space on that side. One pass over the text.
 */
export function plainCodeSpan(text: string): string {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 96) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
