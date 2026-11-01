import {
  CreatePollRequest,
  POLL_MAX_OPTIONS,
  POLL_CLOSE_TRANSIT_MARGIN_MS,
  POLL_MIN_OPTIONS,
  checkClosesAt,
  votePercent,
  type PollChangedPush,
  type PollView,
} from '@manythreads/shared';

/*
 * The pure parts of polls on the page (PLAN P14-07): the dialog's form turned into the request, the rules for a vote shown before the server answers,
 * and the words on the card. No React and no network, so all of it is tested without a browser. The server stays the authority on every rule.
 */

/** "Closes in": the choices the dialog offers. `never` leaves the poll open until its author closes it. */
export type CloseUnit = 'never' | 'minutes' | 'hours' | 'days';
export type PollForm = {
  question: string;
  /** One text per box, including empty ones (the dialog keeps spare boxes). */
  options: readonly string[];
  multiple: boolean;
  anonymous: boolean;
  closeUnit: CloseUnit;
  /** How many of the unit; a whole number as typed. */
  closeAmount: string;
};

export const EMPTY_FORM: PollForm = { question: '', options: ['', ''], multiple: false, anonymous: false, closeUnit: 'never', closeAmount: '1' };
export const UNIT_MS: Record<Exclude<CloseUnit, 'never'>, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const UNIT_LABEL: Record<CloseUnit, string> = { never: 'Never (I close it)', minutes: 'minutes', hours: 'hours', days: 'days' };

/** The exact closing moment a form asks for, or an error sentence; null when the poll never closes by itself. */
export function closesAtOf(form: Pick<PollForm, 'closeUnit' | 'closeAmount'>, now: Date): { ok: true; at: string | null } | { ok: false; reason: string } {
  if (form.closeUnit === 'never') return { ok: true, at: null };
  const text = form.closeAmount.trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1) return { ok: false, reason: 'Say in how many minutes, hours or days the poll closes, with a whole number of at least 1.' };
  // a few seconds more than asked, so "in 1 minute" is still a minute away when the request reaches the server (which wants at least one)
  const at = new Date(now.getTime() + Number(text) * UNIT_MS[form.closeUnit] + POLL_CLOSE_TRANSIT_MARGIN_MS);
  const checked = checkClosesAt(at, now);
  return checked.ok ? { ok: true, at: checked.at.toISOString() } : { ok: false, reason: checked.reason };
}

/** The dialog's starting values for a half-typed `/poll "Question" "First"`: the question and what options there are, topped up to the two boxes the form keeps. */
export function formFromPrefill(prefill: { question: string; options: readonly string[] }): Partial<PollForm> {
  const options = [...prefill.options];
  while (options.length < POLL_MIN_OPTIONS) options.push('');
  return { question: prefill.question, options };
}

/** One line in a box, the way the server keeps it: line breaks and runs of spaces become one space. */
export const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();

/** The dialog's boxes with the empty ones dropped and the rest trimmed. */
export const filledOptions = (options: readonly string[]): string[] => options.map(oneLine).filter((o) => o !== '');

/** The request for a form, or the first thing to fix in words. */
export function requestOf(form: PollForm, now: Date, threadRootId: string | null): { ok: true; request: CreatePollRequest } | { ok: false; reason: string } {
  const closes = closesAtOf(form, now);
  if (!closes.ok) return closes;
  const built = CreatePollRequest.safeParse({
    question: oneLine(form.question),
    options: filledOptions(form.options),
    multiple: form.multiple,
    anonymous: form.anonymous,
    ...(closes.at ? { closesAt: closes.at } : {}),
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (!built.success) return { ok: false, reason: built.error.issues[0]?.message ?? 'The poll is not complete.' };
  return { ok: true, request: built.data };
}

export const canAddOption = (options: readonly string[]): boolean => options.length < POLL_MAX_OPTIONS;
export const canRemoveOption = (options: readonly string[]): boolean => options.length > POLL_MIN_OPTIONS;

/** The poll as it will be once this vote is counted (shown at once; the server's answer replaces it). One vote per person unless several are allowed. */
export function withVote(poll: PollView, options: readonly number[]): PollView {
  const chosen = [...new Set(options)].filter((o) => o >= 0 && o < poll.options.length).sort((a, b) => a - b);
  const next = poll.multiple ? chosen : chosen.slice(0, 1);
  const had = poll.mine;
  return {
    ...poll,
    mine: next,
    voters: Math.max(0, poll.voters + (had.length === 0 && next.length > 0 ? 1 : had.length > 0 && next.length === 0 ? -1 : 0)),
    options: poll.options.map((o, i) => ({ ...o, votes: Math.max(0, o.votes + (next.includes(i) ? 1 : 0) - (had.includes(i) ? 1 : 0)) })),
  };
}

/** The new set of choices when the reader presses one option. */
export function toggled(poll: Pick<PollView, 'multiple' | 'mine'>, option: number): number[] {
  if (!poll.multiple) return [option];
  return poll.mine.includes(option) ? poll.mine.filter((o) => o !== option) : [...poll.mine, option].sort((a, b) => a - b);
}

/**
 * What a press on `option` asks for, counted from the newest wish when a vote request is still out (`wanted`), else from the poll's own choices.
 * `null` when the press changes nothing (a single-choice poll already wanting that option).
 */
export function nextWish(poll: Pick<PollView, 'multiple' | 'mine'>, wanted: readonly number[] | null, option: number): number[] | null {
  const base = wanted ?? poll.mine;
  if (!poll.multiple && base.includes(option)) return null;
  return toggled({ multiple: poll.multiple, mine: [...base] }, option);
}

/** True when two lists of chosen options hold the same options. */
export const sameChoices = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/**
 * The totals a `poll.changed` push carries, put on the poll; the reader's own vote is not in a push and stays as it was. A push older than the poll the
 * page holds (versions only go up) changes nothing, and a poll that is closed here never opens again because of one.
 */
export function withTotals(
  poll: PollView,
  totals: Pick<PollChangedPush, 'votes' | 'voters' | 'version' | 'closed' | 'closedAt' | 'resultMessageId'>,
): PollView {
  if (totals.version < poll.version) return poll;
  return {
    ...poll,
    options: poll.options.map((o, i) => ({ ...o, votes: totals.votes[i] ?? o.votes })),
    voters: totals.voters,
    version: totals.version,
    closed: poll.closed || totals.closed,
    closedAt: poll.closedAt ?? totals.closedAt,
    resultMessageId: poll.resultMessageId ?? totals.resultMessageId,
  };
}

/** A whole poll the server sent (an answer to the reader's own action, or a fresh read): taken unless the page already holds a newer one; closed stays closed. */
export function withServerPoll(poll: PollView, incoming: PollView): PollView {
  if (incoming.version < poll.version) return poll;
  return poll.closed && !incoming.closed ? { ...incoming, closed: true, closedAt: poll.closedAt ?? incoming.closedAt } : incoming;
}

/** The poll as the clock sees it: a poll whose closing time has passed is closed, before the job that records it has run. */
export const closedByClock = (poll: PollView, now: Date): PollView =>
  !poll.closed && poll.closesAt !== null && Date.parse(poll.closesAt) <= now.getTime() ? { ...poll, closed: true } : poll;

/** The share of an option, 0 to 100, for the width of its bar and the number beside it. */
export const optionPercent = (poll: Pick<PollView, 'voters'>, votes: number): number => votePercent(votes, poll.voters);

/** "12 votes · 3 of you", one line under the options: what is going on with the poll, in words. */
export function pollStatus(poll: Pick<PollView, 'closed' | 'closesAt' | 'anonymous' | 'multiple'>, now: Date): string {
  const parts: string[] = [poll.anonymous ? 'Anonymous' : 'Public votes'];
  parts.push(poll.multiple ? 'choose one or more' : 'choose one');
  if (poll.closed) parts.push('closed');
  else if (poll.closesAt) parts.push(`closes ${closesIn(poll.closesAt, now)}`);
  return parts.join(' · ');
}

/** "in 5 minutes", "in 2 hours", "in 3 days", "in under a minute": a rough, honest distance to a closing time. */
export function closesIn(at: string, now: Date): string {
  const ms = Date.parse(at) - now.getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'in under a minute';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} ${min === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

/** The sentence for a vote or close that the server refused. */
export function pollFailureText(status: number | undefined, message: string | undefined): string {
  if (status === 409 && message) return message;
  if (status === 403) return message && message.length < 120 ? message : 'You are not allowed to do that on this poll.';
  if (status === 404) return 'This poll could not be found. It may have been deleted.';
  if (status === 429) return 'Too many votes in a short time. Wait a moment and try again.';
  if (message && status !== undefined && status < 500) return message;
  return 'That did not go through. Try again in a moment.';
}
