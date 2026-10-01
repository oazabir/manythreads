import { z } from 'zod';

/** Password policy (SPEC §4): at least 12 characters. The message is shown to the person as written. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** A password someone is setting (bootstrap, reset, accept invite, change). Sign-in itself never applies the rule. */
export const NewPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
export type NewPassword = z.infer<typeof NewPassword>;

/** An email address as typed; the server lower-cases it before any lookup. */
export const EmailAddress = z.string().trim().max(320).pipe(z.email('Enter a valid email address.'));
export type EmailAddress = z.infer<typeof EmailAddress>;
