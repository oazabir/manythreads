import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { AuthProviderKind } from '../../entities/auth.ts';
import { TeamRole } from '../../entities/team.ts';
import { WorkspaceRole } from '../../entities/workspace.ts';
import { PersonId, WorkspaceId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

/** A sign-in method the workspace has enabled, as the sign-in screen shows it. */
export const SignInMethod = z.object({
  kind: AuthProviderKind,
  label: z.string(),
});
export type SignInMethod = z.infer<typeof SignInMethod>;

export const SessionPerson = z.object({ id: PersonId, name: z.string(), email: z.string() });
export type SessionPerson = z.infer<typeof SessionPerson>;

export const SessionWorkspace = z.object({ id: WorkspaceId, name: z.string() });
export type SessionWorkspace = z.infer<typeof SessionWorkspace>;

export const SessionTeam = z.object({ slug: z.string(), name: z.string(), role: TeamRole });
export type SessionTeam = z.infer<typeof SessionTeam>;

/** Who is signed in: the person, their workspace role and team memberships, and when this session ends. */
export const AuthenticatedSession = z.object({
  authenticated: z.literal(true),
  person: SessionPerson,
  workspace: SessionWorkspace,
  role: WorkspaceRole,
  teams: z.array(SessionTeam),
  /** Sign-in methods the workspace has enabled. */
  methods: z.array(SignInMethod),
  /** Absolute expiry of this session; idle expiry comes sooner when the browser is quiet. */
  expiresAt: IsoDateTime,
});
export type AuthenticatedSession = z.infer<typeof AuthenticatedSession>;

export const AnonymousSession = z.object({
  authenticated: z.literal(false),
  methods: z.array(SignInMethod),
});
export type AnonymousSession = z.infer<typeof AnonymousSession>;

/** `GET /api/session`: public. Anonymous callers get the enabled methods only. */
export const GetSessionResponse = z.discriminatedUnion('authenticated', [AuthenticatedSession, AnonymousSession]);
export type GetSessionResponse = z.infer<typeof GetSessionResponse>;

export const getSessionRoute = { method: 'GET', path: '/api/session' } as const satisfies ApiRoute;
