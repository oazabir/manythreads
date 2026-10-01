import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { EmailAddress, NewPassword } from './password.ts';

/** Always answered with 202, whether or not the address exists. */
export const RequestPasswordResetRequest = z.strictObject({ email: EmailAddress });
export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequest>;
export const RequestPasswordResetResponse = z.object({ accepted: z.literal(true) });
export type RequestPasswordResetResponse = z.infer<typeof RequestPasswordResetResponse>;
export const requestPasswordResetRoute = { method: 'POST', path: '/api/auth/password/reset-request' } as const satisfies ApiRoute;

export const ResetPasswordRequest = z.strictObject({
  token: z.string().min(16).max(256),
  password: NewPassword,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;
export const ResetPasswordResponse = z.object({ ok: z.literal(true) });
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponse>;
export const resetPasswordRoute = { method: 'POST', path: '/api/auth/password/reset' } as const satisfies ApiRoute;
