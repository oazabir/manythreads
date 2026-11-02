import { z } from 'zod';
import { WorkshopSessionId } from '../../ids.ts';
import { WORKSHOP_MESSAGE_MAX, WorkshopMode, WorkshopSession, WorkshopSessionSummary } from '../../entities/workshop.ts';

// The routes of the Workshop tab (PLAN P7-05). A conversation is its owner's alone: nobody else, a lead and an admin included, reads or continues it (a plain 404).

export const WorkshopBotParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1) });
export type WorkshopBotParams = z.infer<typeof WorkshopBotParams>;
export const WorkshopSessionParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1), sessionId: WorkshopSessionId });
export type WorkshopSessionParams = z.infer<typeof WorkshopSessionParams>;

const Text = z.string().trim().min(1, 'Write something first.').max(WORKSHOP_MESSAGE_MAX);

/** Start a conversation in one mode, optionally with the first message. */
export const CreateWorkshopSessionRequest = z.strictObject({ mode: WorkshopMode, text: Text.optional() });
export type CreateWorkshopSessionRequest = z.infer<typeof CreateWorkshopSessionRequest>;

/** `about`: the reply of one of the person's own Rehearse conversations that this message corrects; the server reads it from there. */
export const WorkshopAbout = z.strictObject({ sessionId: WorkshopSessionId, entryId: z.string().regex(/^e[0-9]{1,4}$/) });
export type WorkshopAbout = z.infer<typeof WorkshopAbout>;
export const PostWorkshopMessageRequest = z.strictObject({ text: Text, about: WorkshopAbout.optional() });
export type PostWorkshopMessageRequest = z.infer<typeof PostWorkshopMessageRequest>;

export const EndWorkshopSessionRequest = z.strictObject({});
export type EndWorkshopSessionRequest = z.infer<typeof EndWorkshopSessionRequest>;

export const WorkshopSessionResponse = z.object({ session: WorkshopSession });
export type WorkshopSessionResponse = z.infer<typeof WorkshopSessionResponse>;
export const WorkshopSessionListResponse = z.object({ sessions: z.array(WorkshopSessionSummary) });
export type WorkshopSessionListResponse = z.infer<typeof WorkshopSessionListResponse>;

export const createWorkshopSessionRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/workshop/sessions' } as const;
export const listWorkshopSessionsRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/workshop/sessions' } as const;
export const getWorkshopSessionRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/workshop/sessions/:sessionId' } as const;
export const postWorkshopMessageRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/workshop/sessions/:sessionId/messages' } as const;
export const endWorkshopSessionRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/workshop/sessions/:sessionId/end' } as const;
