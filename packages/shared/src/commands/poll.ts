import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, pollOptionKey } from '../entities/poll.ts';

/*
 * `/poll "Question" "Option 1" "Option 2" …` (PLAN P14-07): the words after the command are read as quoted pieces, the first the question and the
 * rest the options. Pure text rules, one pass over the text (linear time), so the browser and the tests read a command the same way. Straight
 * and curly double quotes both open and close a piece; a backslash puts a quote mark inside one.
 */

export type PollArgs =
  /** Nothing was typed after `/poll`: open the form. */
  | { kind: 'empty' }
  /** A question (and fewer than two options): open the form with these filled in rather than refuse. */
  | { kind: 'partial'; question: string; options: string[] }
  | { kind: 'ok'; question: string; options: string[] }
  | { kind: 'error'; reason: string };

export const POLL_USAGE = 'Write the question and the options in quotes, for example /poll "Lunch?" "Pizza" "Sushi", or type /poll alone to fill in a form.';

const OPEN = new Set(['"', '“', '„']);
const CLOSE = new Set(['"', '”', '“']);

/** The quoted pieces of `text`, or the reason it cannot be read as pieces. */
function pieces(text: string): { ok: true; list: string[] } | { ok: false; reason: string } {
  const list: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (!OPEN.has(c)) return { ok: false, reason: POLL_USAGE };
    let piece = '';
    i += 1;
    let closed = false;
    while (i < text.length) {
      const d = text[i] ?? '';
      if (d === '\\' && i + 1 < text.length && (OPEN.has(text[i + 1] ?? '') || CLOSE.has(text[i + 1] ?? '') || text[i + 1] === '\\')) {
        piece += text[i + 1];
        i += 2;
        continue;
      }
      if (CLOSE.has(d)) {
        closed = true;
        i += 1;
        break;
      }
      piece += d;
      i += 1;
    }
    if (!closed) return { ok: false, reason: 'A quote is not closed. Put each piece between two quote marks.' };
    // a piece must be followed by a space or the end: "A"B" is a mistake, not an option
    if (i < text.length && !/\s/.test(text[i] ?? '')) return { ok: false, reason: 'Put a space between the quoted pieces.' };
    list.push(piece.replace(/\s+/g, ' ').trim());
  }
  return { ok: true, list };
}

/** Reads what follows `/poll`. The limits are the ones the server enforces, said in words before anything is sent. */
export function parsePollArgs(args: string): PollArgs {
  const text = args.trim();
  if (text === '') return { kind: 'empty' };
  const read = pieces(text);
  if (!read.ok) return { kind: 'error', reason: read.reason };
  const [question, ...options] = read.list;
  if (!question) return { kind: 'error', reason: 'The question is empty.' };
  if (question.length > POLL_QUESTION_MAX) return { kind: 'error', reason: `A question can have at most ${POLL_QUESTION_MAX} characters. This one has ${question.length}.` };
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(read.list.join(' '))) return { kind: 'error', reason: 'Write the poll without control characters.' };
  if (options.length < POLL_MIN_OPTIONS) return { kind: 'partial', question, options: options.filter((o) => o !== '') };
  if (options.length > POLL_MAX_OPTIONS) return { kind: 'error', reason: `A poll can have at most ${POLL_MAX_OPTIONS} options. This one has ${options.length}.` };
  const empty = options.findIndex((o) => o === '');
  if (empty !== -1) return { kind: 'error', reason: `Option ${empty + 1} is empty.` };
  const long = options.findIndex((o) => o.length > POLL_OPTION_MAX);
  if (long !== -1) return { kind: 'error', reason: `Option ${long + 1} is longer than ${POLL_OPTION_MAX} characters.` };
  if (new Set(options.map(pollOptionKey)).size !== options.length) return { kind: 'error', reason: 'Two options are the same.' };
  return { kind: 'ok', question, options };
}
