import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { NewPassword } from './password.ts';

/**
 * A signed-in person changes their own password. The current password is checked first (a stolen session alone cannot
 * set a new one); every other session of the person ends, this one stays, and outstanding reset links are spent.
 */
export const ChangePasswordRequest = z.strictObject({
  /** Sign-in never applies the length rule, so neither does this field. */
  currentPassword: z.string().min(1, 'Enter your current password.').max(1024),
  newPassword: NewPassword,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** `revokedSessions` counts the other sessions that were signed out. */
export const ChangePasswordResponse = z.object({ ok: z.literal(true), revokedSessions: z.number().int().nonnegative() });
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponse>;
export const changePasswordRoute = { method: 'POST', path: '/api/auth/password/change' } as const satisfies ApiRoute;
