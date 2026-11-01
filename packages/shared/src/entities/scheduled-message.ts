import { z } from 'zod';

// Scheduled send (PLAN P14-05, plugin `channels`): a person writes a message now and chooses when it is posted. Shared so the browser and the
// server agree on the limits and on the one rule about the send time.

/**
 * `scheduled`: waiting for its time. `refused`: its time came and the person could no longer post there (or the post failed); the draft stays with
 * its reason until the person edits and reschedules it or removes it. A message that was sent, or cancelled, is gone from the table (the event
 * log keeps the record).
 */
export const ScheduledMessageState = z.enum(['scheduled', 'refused']);
export type ScheduledMessageState = z.infer<typeof ScheduledMessageState>;

/** The most scheduled and refused messages one person holds at once. */
export const SCHEDULED_MAX_PER_PERSON = 100;

/** A send time up to this long ago is accepted (a slow clock, a form left open) and counts as now. */
export const SCHEDULED_PAST_SKEW_MS = 60_000;

/** A message is scheduled at most a year ahead. */
export const SCHEDULED_MAX_AHEAD_MS = 365 * 24 * 3_600_000;

/** What is wrong with a send time, in words for the person; the server and the custom-time form both say these. */
export const SCHEDULED_TIME_PAST = 'That time has already passed. Choose a later one.';
export const SCHEDULED_TIME_FAR = 'A message can be scheduled at most a year ahead.';
export const SCHEDULED_TIME_BAD = 'That is not a time.';

export type SendAtCheck = { ok: true; at: Date } | { ok: false; reason: string };

/**
 * Is this a time a message may be scheduled for, now? Not in the past (a minute of slack is allowed, and such a time counts as now) and within a
 * year. `at` is a Date or an ISO string; anything unreadable is refused.
 */
export function checkSendAt(at: Date | string, now: Date): SendAtCheck {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(t)) return { ok: false, reason: SCHEDULED_TIME_BAD };
  if (t < now.getTime() - SCHEDULED_PAST_SKEW_MS) return { ok: false, reason: SCHEDULED_TIME_PAST };
  if (t > now.getTime() + SCHEDULED_MAX_AHEAD_MS) return { ok: false, reason: SCHEDULED_TIME_FAR };
  return { ok: true, at: new Date(Math.max(t, now.getTime())) };
}
