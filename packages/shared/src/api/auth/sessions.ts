import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { SessionId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

/** One of the caller's own sessions. Never carries the token or its hash. */
export const SessionSummary = z.object({
  id: SessionId,
  /** A short device label such as `Chrome on macOS`. */
  label: z.string(),
  current: z.boolean(),
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const ListSessionsResponse = z.object({ sessions: z.array(SessionSummary) });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;
export const listSessionsRoute = { method: 'GET', path: '/api/auth/sessions' } as const satisfies ApiRoute;

export const RevokeSessionResponse = z.object({ ok: z.literal(true) });
export type RevokeSessionResponse = z.infer<typeof RevokeSessionResponse>;
export const revokeSessionRoute = { method: 'DELETE', path: '/api/auth/sessions/:id' } as const satisfies ApiRoute;
