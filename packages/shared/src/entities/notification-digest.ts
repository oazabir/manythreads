import { z } from 'zod';

// The email digest (PLAN P14-09): after a person has been away for a while, one mail lists the mentions, replies and direct messages they have not
// read. The rules the server and the settings screen share live here, so the screen offers exactly the delays the server accepts.

/** Shortest and longest time away before a digest may be sent, in minutes (30 minutes to 24 hours). */
export const DIGEST_DELAY_MIN = 30;
export const DIGEST_DELAY_MAX = 1440;
/** The delay a person has until they choose another: one hour. */
export const DIGEST_DELAY_DEFAULT = 60;
/** At most this many messages are listed in one mail; the rest is a count ("and 4 more"). */
export const DIGEST_MAX_ITEMS = 10;
/** A message is shown as its first 140 characters. */
export const DIGEST_EXCERPT_MAX = 140;

/** The delays the settings screen offers, in minutes. The server accepts any whole number of minutes from 30 to 1,440. */
export const DIGEST_DELAY_CHOICES: readonly number[] = [30, 60, 120, 240, 480, 1440];

/** "30 minutes", "1 hour", "2 hours", "24 hours": the words for a delay. */
export function digestDelayLabel(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export const DigestDelayMinutes = z.number().int().min(DIGEST_DELAY_MIN).max(DIGEST_DELAY_MAX);

/**
 * A person's digest settings. `emailAvailable` is false when the person has no verified email address: the mail would have nowhere to go, so the
 * screen says so instead of offering a switch that does nothing. `lastSentAt` is when the latest digest went out (null: none yet).
 */
export const DigestSettings = z.object({
  enabled: z.boolean(),
  delayMinutes: DigestDelayMinutes,
  emailAvailable: z.boolean(),
  lastSentAt: z.string().nullable(),
});
export type DigestSettings = z.infer<typeof DigestSettings>;
