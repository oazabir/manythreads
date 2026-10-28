import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { PersonId } from '../ids.ts';

// Presence and status (PLAN P14-01): what a person says about themself beside their name. A custom status, working hours in a time zone, an
// out-of-office note and Do not disturb. The heartbeat that says "online" or "away" is older (api/channels/ephemeral.ts); a card joins both.

/** Longest custom status text and emoji (the emoji field holds one picture, possibly a sequence of code points). */
export const STATUS_TEXT_MAX = 100;
export const STATUS_EMOJI_MAX = 16;
export const OUT_OF_OFFICE_MESSAGE_MAX = 200;

/** True for a name the runtime's time zone database knows (`Asia/Karachi`, `America/New_York`, `UTC`). */
export function isValidTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name such as `Europe/Berlin`. */
export const TimeZone = z.string().refine(isValidTimeZone, 'Unknown time zone');
export type TimeZone = z.infer<typeof TimeZone>;

/** A clock time `HH:MM`, 24 hours. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
export type ClockTime = z.infer<typeof ClockTime>;

/** Day of the week, 0 = Sunday … 6 = Saturday (the order of `Date.getDay`). */
export const Weekday = z.number().int().min(0).max(6);
export type Weekday = z.infer<typeof Weekday>;
const Weekdays = z.array(Weekday).min(1).max(7).refine((days) => new Set(days).size === days.length, 'Each day once');

/** Minutes after midnight of a `HH:MM` string. */
export const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// ---- custom status ---------------------------------------------------------------------------------------------------------------

/** The status as everyone reads it. A status past `clearsAt` is not served (readers drop it, so nothing has to delete it on time). */
export const CustomStatus = z.object({
  emoji: z.string().min(1).max(STATUS_EMOJI_MAX).nullable(),
  text: z.string().max(STATUS_TEXT_MAX),
  clearsAt: IsoDateTime.nullable(),
});
export type CustomStatus = z.infer<typeof CustomStatus>;

/** What a person sends: an emoji or text (or both), and when to clear it (`null`: never). */
export const CustomStatusInput = z
  .strictObject({
    emoji: z.string().trim().min(1).max(STATUS_EMOJI_MAX).nullable(),
    text: z.string().trim().max(STATUS_TEXT_MAX),
    clearsAt: IsoDateTime.nullable(),
  })
  .refine((s) => s.emoji !== null || s.text !== '', 'A status needs an emoji or some words');
export type CustomStatusInput = z.infer<typeof CustomStatusInput>;

// ---- working hours and out of office ---------------------------------------------------------------------------------------------

/** Working days and the hours within them, in the person's own time zone. The day ends after it starts (no overnight shift here). */
export const WorkingHours = z
  .strictObject({ days: Weekdays, start: ClockTime, end: ClockTime })
  .refine((h) => minutesOf(h.start) < minutesOf(h.end), 'Working hours must end after they start');
export type WorkingHours = z.infer<typeof WorkingHours>;

const outOfOfficeShape = {
  active: z.boolean(),
  /** The first day back, a calendar date `YYYY-MM-DD`. */
  returnsOn: z.iso.date().nullable(),
  /** Who to ask meanwhile (a person on the workspace). */
  delegatePersonId: PersonId.nullable(),
  message: z.string().max(OUT_OF_OFFICE_MESSAGE_MAX),
};
/** Out of office: stored and shown; the approvals routing of P18-03 reads it. */
export const OutOfOffice = z.object(outOfOfficeShape);
export type OutOfOffice = z.infer<typeof OutOfOffice>;
export const OutOfOfficeInput = z.strictObject({ ...outOfOfficeShape, message: z.string().trim().max(OUT_OF_OFFICE_MESSAGE_MAX) });
export type OutOfOfficeInput = z.infer<typeof OutOfOfficeInput>;

// ---- Do not disturb --------------------------------------------------------------------------------------------------------------

/**
 * One weekly quiet period: on these days, from `start` to `end` local time. An `end` before the `start` runs overnight and belongs to the
 * day it started on (Friday 22:00 to 07:00 ends Saturday morning).
 */
export const DndWindow = z
  .strictObject({ days: Weekdays, start: ClockTime, end: ClockTime })
  .refine((w) => w.start !== w.end, 'A quiet period needs a start and an end that differ');
export type DndWindow = z.infer<typeof DndWindow>;

export const DndSchedule = z.strictObject({ enabled: z.boolean(), windows: z.array(DndWindow).max(7) });
export type DndSchedule = z.infer<typeof DndSchedule>;

/** A person's Do not disturb settings: switched on by hand, paused until a time, or on a weekly schedule. Private to the person. */
export const DndSettings = z.object({ enabled: z.boolean(), pausedUntil: IsoDateTime.nullable(), schedule: DndSchedule });
export type DndSettings = z.infer<typeof DndSettings>;
export const DEFAULT_DND_SETTINGS: DndSettings = { enabled: false, pausedUntil: null, schedule: { enabled: false, windows: [] } };

/** Whether Do not disturb is on right now, why, and when it ends (`null`: until the person turns it off, or a schedule that never ends). */
export const DndState = z.object({
  active: z.boolean(),
  reason: z.enum(['manual', 'paused', 'schedule']).nullable(),
  until: IsoDateTime.nullable(),
});
export type DndState = z.infer<typeof DndState>;

// ---- presence cards ----------------------------------------------------------------------------------------------------------------

/** `online` and `away` come from the heartbeat; a person with no recent heartbeat is `offline`. */
export const PresenceState = z.enum(['online', 'away', 'offline']);
export type PresenceState = z.infer<typeof PresenceState>;

/** Everything shown beside a name and on a profile card. Do not disturb is not here: it is the person's own business. */
export const PresenceCard = z.object({
  personId: PersonId,
  presence: PresenceState,
  seenAt: IsoDateTime.nullable(),
  status: CustomStatus.nullable(),
  timeZone: z.string().nullable(),
  workingHours: WorkingHours.nullable(),
  outOfOffice: OutOfOffice.nullable(),
});
export type PresenceCard = z.infer<typeof PresenceCard>;
