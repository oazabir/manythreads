import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';

/** Signed-in: mails a verification link to the caller's primary address. */
export const RequestEmailVerificationResponse = z.object({ accepted: z.literal(true) });
export type RequestEmailVerificationResponse = z.infer<typeof RequestEmailVerificationResponse>;
export const requestEmailVerificationRoute = { method: 'POST', path: '/api/auth/email/verify-request' } as const satisfies ApiRoute;

export const VerifyEmailRequest = z.strictObject({ token: z.string().min(16).max(256) });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;
export const VerifyEmailResponse = z.object({ ok: z.literal(true), email: z.string() });
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponse>;
export const verifyEmailRoute = { method: 'POST', path: '/api/auth/email/verify' } as const satisfies ApiRoute;
