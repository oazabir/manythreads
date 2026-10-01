import { z } from 'zod';
import { PersonId, SessionId, WorkspaceId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

/**
 * TEST ONLY: `POST /api/test/session`. Mounted when MANYTHREADS_TEST_AUTH_TOKEN is set and answers only a request
 * carrying `x-test-auth: <that token>`. Issues a real session (cookies) for an existing person.
 */
export const CreateTestSessionRequest = z.strictObject({ email: z.string().trim().min(1).max(320) });
export type CreateTestSessionRequest = z.infer<typeof CreateTestSessionRequest>;
export const CreateTestSessionResponse = z.object({
  sessionId: SessionId,
  personId: PersonId,
  workspaceId: WorkspaceId,
  /** The value of the readable `manythreads_csrf` cookie, for clients that cannot read cookies. */
  csrfToken: z.string(),
});
export type CreateTestSessionResponse = z.infer<typeof CreateTestSessionResponse>;
export const createTestSessionRoute = { method: 'POST', path: '/api/test/session' } as const satisfies ApiRoute;
