import { STATUS_EMOJI_MAX, STATUS_TEXT_MAX } from '../entities/presence.ts';
import { DURATION_USAGE, parseDurationOnly } from './when.ts';

/*
 * The words after `/status`, `/dnd`, `/mute`, `/invite` and `/topic` (PLAN P14-06). Each reads one line into a small description of what to ask
 * the owning plugin's existing route to do; none of them changes anything itself. One pass over the text, no regular expression that can backtrack.
 */

/** The most minutes a pause of Do not disturb can last (the presence route's limit: seven days). */
export const DND_MAX_MINUTES = 7 * 24 * 60;
/** A channel's topic (purpose) is at most this long (the channel route's limit). */
export const TOPIC_MAX = 250;

const isBlank = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/** The first word of `text` and the trimmed rest. */
export function splitFirstWord(text: string): { word: string; rest: string } {
  const t = text.trim();
  let end = 0;
  while (end < t.length && !isBlank(t[end])) end += 1;
  return { word: t.slice(0, end), rest: t.slice(end).trim() };
}

// ---- /status -----------------------------------------------------------------------------------------------------------------------

export type StatusArgs =
  | { kind: 'clear' }
  | { kind: 'set'; emoji: string | null; text: string }
  | { kind: 'error'; reason: string };

export const STATUS_USAGE = 'Write your status after /status, for example /status in a meeting, or /status 🌴 on holiday. /status clear removes it.';

const PICTOGRAPH = /^\p{Extended_Pictographic}/u;

/**
 * `/status <text>` sets the status; the first word may be an emoji (`/status 🌴 on holiday`, or an emoji alone); `/status clear` removes it. The
 * status never clears by itself (the settings screen sets a clearing time).
 */
export function parseStatusArgs(args: string): StatusArgs {
  const text = args.replace(/\s+/g, ' ').trim();
  if (text === '') return { kind: 'error', reason: STATUS_USAGE };
  if (text.toLowerCase() === 'clear') return { kind: 'clear' };
  const { word, rest } = splitFirstWord(text);
  let emoji: string | null = null;
  let body = text;
  // a first word that is made of nothing but pictographs and the marks that join them (flags, skin tones, ZWJ sequences) is the emoji
  if (word.length <= STATUS_EMOJI_MAX && PICTOGRAPH.test(word) && !/[\p{L}\p{N}]/u.test(word)) {
    emoji = word;
    body = rest;
  }
  if (body === '' && emoji === null) return { kind: 'error', reason: STATUS_USAGE };
  if ([...body].length > STATUS_TEXT_MAX) return { kind: 'error', reason: `A status can have at most ${STATUS_TEXT_MAX} characters. This one has ${[...body].length}.` };
  return { kind: 'set', emoji, text: body };
}

// ---- /dnd and /mute -----------------------------------------------------------------------------------------------------------------

export type DndArgs = { kind: 'off' } | { kind: 'pause'; minutes: number } | { kind: 'error'; reason: string };

export const DND_USAGE = 'Say for how long, for example /dnd 2h or /dnd 30m, or /dnd off to get your notifications back.';

/** `/dnd 2h` pauses notifications for that long (at most seven days); `/dnd off` ends a pause or a hand-set Do not disturb. */
export function parseDndArgs(args: string): DndArgs {
  const text = args.trim();
  if (text === '') return { kind: 'error', reason: DND_USAGE };
  if (text.toLowerCase() === 'off') return { kind: 'off' };
  const d = parseDurationOnly(text);
  if (!d.ok) return { kind: 'error', reason: d.reason === DURATION_USAGE ? DND_USAGE : d.reason };
  if (d.minutes > DND_MAX_MINUTES) return { kind: 'error', reason: 'Do not disturb can be paused for at most 7 days.' };
  return { kind: 'pause', minutes: d.minutes };
}

export type MuteArgs = { kind: 'mute' } | { kind: 'unmute' } | { kind: 'error'; reason: string };

export const MUTE_FOR_A_TIME =
  'Muting for a set time is not available yet. /mute keeps this conversation quiet until you type /mute off. To be reminded to unmute, use /remind me in 1h unmute this channel.';

/** `/mute` makes the conversation silent for the person (their level “nothing”); `/mute off` lets it follow the default again. A length of time is refused with a sentence. */
export function parseMuteArgs(args: string): MuteArgs {
  const text = args.trim();
  if (text === '') return { kind: 'mute' };
  const lower = text.toLowerCase();
  if (lower === 'off' || lower === 'on') return lower === 'off' ? { kind: 'unmute' } : { kind: 'mute' };
  if (parseDurationOnly(text).ok) return { kind: 'error', reason: MUTE_FOR_A_TIME };
  return { kind: 'error', reason: 'Type /mute to silence this conversation, or /mute off to hear it again.' };
}

// ---- /invite and /topic -------------------------------------------------------------------------------------------------------------

export type InviteArgs = { kind: 'ok'; handle: string } | { kind: 'error'; reason: string };

export const INVITE_USAGE = 'Say who to add, for example /invite @priya.';

/** `/invite @person`: exactly one name. The page finds the person on the team's roster. */
export function parseInviteArgs(args: string): InviteArgs {
  const { word, rest } = splitFirstWord(args);
  if (word === '') return { kind: 'error', reason: INVITE_USAGE };
  if (rest !== '') return { kind: 'error', reason: 'Name one person at a time, for example /invite @priya.' };
  const name = word.startsWith('@') ? word.slice(1) : word;
  if (name === '' || name.length > 80) return { kind: 'error', reason: INVITE_USAGE };
  return { kind: 'ok', handle: name };
}

export type TopicArgs = { kind: 'ok'; text: string } | { kind: 'error'; reason: string };

/** `/topic <text>` sets the channel's topic (its purpose line); `/topic clear` empties it. */
export function parseTopicArgs(args: string): TopicArgs {
  const text = args.replace(/\s+/g, ' ').trim();
  if (text === '') return { kind: 'error', reason: 'Write the new topic after /topic, for example /topic Release planning. /topic clear removes it.' };
  if (text.toLowerCase() === 'clear') return { kind: 'ok', text: '' };
  const n = [...text].length;
  if (n > TOPIC_MAX) return { kind: 'error', reason: `A topic can have at most ${TOPIC_MAX} characters. This one has ${n}.` };
  return { kind: 'ok', text };
}
