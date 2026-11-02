import { z } from 'zod';
import { RunId, TerminalSessionId } from '../../ids.ts';
import { TerminalLimitsShape, TerminalRecording, TerminalSession } from '../../entities/terminal.ts';

// The routes of the terminal into a bot's sandbox (PLAN P7-09). Every one is for a workspace admin and answers 403 to anyone else, including the socket's upgrade.

export const TerminalBotParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1) });
export type TerminalBotParams = z.infer<typeof TerminalBotParams>;
export const TerminalParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1), terminalId: TerminalSessionId });
export type TerminalParams = z.infer<typeof TerminalParams>;

/** Asks for a terminal. `runId`, when given, names a rehearsal run of this bot to attach to; a run that is not a rehearsal is refused. Without it a fresh sandbox is made. */
export const OpenTerminalRequest = z.strictObject({ runId: RunId.optional() });
export type OpenTerminalRequest = z.infer<typeof OpenTerminalRequest>;
export const EndTerminalRequest = z.strictObject({});
export type EndTerminalRequest = z.infer<typeof EndTerminalRequest>;

/** Whether a terminal can be opened on this server right now, and the recent ones for this bot. `reason` says in plain words why not. */
export const TerminalStatusResponse = z.object({
  available: z.boolean(),
  reason: z.string().max(400).nullable(),
  limits: TerminalLimitsShape,
  sessions: z.array(TerminalSession),
});
export type TerminalStatusResponse = z.infer<typeof TerminalStatusResponse>;
export const TerminalSessionResponse = z.object({ session: TerminalSession });
export type TerminalSessionResponse = z.infer<typeof TerminalSessionResponse>;
export const TerminalRecordingResponse = z.object({ session: TerminalRecording });
export type TerminalRecordingResponse = z.infer<typeof TerminalRecordingResponse>;

export const terminalStatusRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/workshop/terminal' } as const;
export const openTerminalRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/workshop/terminal' } as const;
export const getTerminalRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/workshop/terminal/:terminalId' } as const;
export const endTerminalRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/workshop/terminal/:terminalId/end' } as const;
/** The socket (GET, upgrades). Only a session this admin asked for and has not connected yet can be connected, once. */
export const terminalSocketRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/workshop/terminal/:terminalId/socket' } as const;
