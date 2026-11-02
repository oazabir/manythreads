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

/**
 * Characters that are dropped from a name or an excerpt before it goes into a mail: control characters, the marks that reorder text (U+061C, U+200E,
 * U+200F, U+202A to U+202E, U+2066 to U+2069), zero-width characters, interlinear annotation marks and the invisible "tag" characters. One shared
 * pattern, so the mail template and the plugin that builds the excerpts cannot drift apart.
 */
// eslint-disable-next-line no-control-regex
export const DIGEST_UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

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
 * screen says so instead of offering a switch that does nothing; `mailConfigured` is false when the server itself cannot send mail. `lastSentAt` is when the latest digest went out (null: none yet).
 */
export const DigestSettings = z.object({
  enabled: z.boolean(),
  delayMinutes: DigestDelayMinutes,
  emailAvailable: z.boolean(),
  /** False when this server has no mail server set up (no `MANYTHREADS_SMTP_URL`): no digest can be sent to anyone, whatever their address. */
  mailConfigured: z.boolean(),
  lastSentAt: z.string().nullable(),
});
export type DigestSettings = z.infer<typeof DigestSettings>;
