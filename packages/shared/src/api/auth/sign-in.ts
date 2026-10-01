import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { AuthenticatedSession } from './session.ts';

/** Sign-in never applies the length rule (a wrong 11-character guess is just wrong), only sane bounds. */
export const SignInWithPasswordRequest = z
  .strictObject({
    email: z.string().trim().min(1, 'Enter your email.').max(320),
    password: z.string().min(1, 'Enter your password.').max(1024),
  });
export type SignInWithPasswordRequest = z.infer<typeof SignInWithPasswordRequest>;

export const SignInWithPasswordResponse = AuthenticatedSession;
export type SignInWithPasswordResponse = z.infer<typeof SignInWithPasswordResponse>;

export const signInWithPasswordRoute = { method: 'POST', path: '/api/auth/password/sign-in' } as const satisfies ApiRoute;

export const SignOutResponse = z.object({ ok: z.literal(true) });
export type SignOutResponse = z.infer<typeof SignOutResponse>;
export const signOutRoute = { method: 'POST', path: '/api/auth/sign-out' } as const satisfies ApiRoute;

/** `revoked` counts the sessions that were signed out (this one included). */
export const SignOutEverywhereResponse = z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() });
export type SignOutEverywhereResponse = z.infer<typeof SignOutEverywhereResponse>;
export const signOutEverywhereRoute = { method: 'POST', path: '/api/auth/sign-out-everywhere' } as const satisfies ApiRoute;
