import { z } from 'zod';
import { PersonId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

/** A person edits their own profile. There is no id: the route can only ever touch the caller's own row. */
export const UpdateAccountRequest = z.strictObject({
  displayName: z.string().trim().min(1, 'Enter your name.').max(120, 'Name must be at most 120 characters.'),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export const UpdateAccountResponse = z.object({
  person: z.object({ id: PersonId, name: z.string(), email: z.string() }),
});
export type UpdateAccountResponse = z.infer<typeof UpdateAccountResponse>;
export const updateAccountRoute = { method: 'PATCH', path: '/api/account' } as const satisfies ApiRoute;
