// Later and reminders (PLAN P14-04): the limits and the one rule about reminder times, shared so the browser and the server agree.

/** The most items one person keeps in Later (open and done together; a finished one makes room when the list is full). */
export const LATER_MAX_ITEMS = 200;

/** A reminder time up to this long ago is accepted (a slow clock, a form left open) and fires at once. */
export const LATER_PAST_SKEW_MS = 60_000;

/** A reminder is set at most a year ahead. */
export const LATER_MAX_AHEAD_MS = 365 * 24 * 3_600_000;

/** The snippet of a saved message shown in the list: plain text, one line, at most this many characters. */
export const LATER_SNIPPET_MAX = 200;

/** What is wrong with a reminder time, in words for the person; the server and the custom-time form both say these. */
export const LATER_TIME_PAST = 'That time has already passed. Choose a later one.';
export const LATER_TIME_FAR = 'Reminders can be set at most a year ahead.';

export type RemindAtCheck = { ok: true; at: Date } | { ok: false; reason: string };

/**
 * Is this a time a reminder may be set for, now? It must not be in the past (a minute of slack is allowed, and such a time counts as now) and
 * must be within a year. `at` is a Date or an ISO string; anything unreadable is refused.
 */
export function checkRemindAt(at: Date | string, now: Date): RemindAtCheck {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(t)) return { ok: false, reason: 'That is not a time.' };
  if (t < now.getTime() - LATER_PAST_SKEW_MS) return { ok: false, reason: LATER_TIME_PAST };
  if (t > now.getTime() + LATER_MAX_AHEAD_MS) return { ok: false, reason: LATER_TIME_FAR };
  return { ok: true, at: new Date(Math.max(t, now.getTime())) };
}
