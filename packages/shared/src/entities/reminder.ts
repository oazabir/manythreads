import { z } from 'zod';

// Reminders made with `/remind` (PLAN P14-04, plugin `reminders`): a person asks to be reminded of something at a time, or to remind someone
// else, or a channel. Shared so the browser and the server agree on the limits.

/** Who is reminded: the person who made it (`me`), another person (`person`), or everyone in a channel (`channel`, a message posted there). */
export const ReminderTargetKind = z.enum(['me', 'person', 'channel']);
export type ReminderTargetKind = z.infer<typeof ReminderTargetKind>;

/**
 * `pending`: waiting for its time. `sent`: delivered. `cancelled`: its maker cancelled it. `refused`: its time came and it could not be delivered
 * (the maker could no longer post there, or the person could no longer read the place); `refusedReason` says why in plain words.
 */
export const ReminderState = z.enum(['pending', 'sent', 'cancelled', 'refused']);
export type ReminderState = z.infer<typeof ReminderState>;

/** The reminder text is one line of at most this many characters (a notification shows 140 of them). */
export const REMINDER_TEXT_MAX = 500;

/** The most reminders one person has waiting at once (for themself, others and channels together). */
export const REMINDERS_MAX_PENDING = 100;
/** The most waiting reminders for other people or for channels. */
export const REMINDERS_MAX_PENDING_OTHERS = 20;
/** The most waiting reminders for one other person, from one maker. */
export const REMINDERS_MAX_PENDING_PER_PERSON = 10;
/** The most reminders waiting for one person from all makers together (a reminder for someone else is not held back by their mute, so what one person can be sent is capped). */
export const REMINDERS_MAX_PENDING_PER_RECIPIENT = 20;
/** The most reminders for other people or channels one person makes in an hour. */
export const REMINDERS_MAX_OTHERS_PER_HOUR = 30;
/** A finished reminder (sent, cancelled or refused) stays in the history this many days, then it is removed. */
export const REMINDERS_HISTORY_DAYS = 30;

/**
 * A person's Reminders conversation is a direct message whose `dmKey` is this prefix followed by the person's id (the reminders plugin makes it, in
 * migration 0002, on first use). The page names it "Reminders", and the notifications plugin does not notify twice for what is posted in it.
 */
export const REMINDERS_DM_KEY_PREFIX = 'reminders:';
