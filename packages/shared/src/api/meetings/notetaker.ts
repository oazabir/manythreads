import { z } from 'zod';
import { MeetingNotetaker, MeetingNotetakerBot } from '../../entities/meeting.ts';
import { BotId, MeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// The note-taker of a voice room (PLAN P15-18): a team bot that listens on the server and writes the notes for the organizer. Anyone in the room may add one;
// the organizer or a lead of the team removes it; a room has at most one. Adding it asks everybody for consent again and moves the room's transcription to the server.

/** The bots that may be added here (an active bot of the room's team with the `meeting` trigger) and why none may, when none may. */
export const ListMeetingNotetakersResponse = z.object({
  bots: z.array(MeetingNotetakerBot),
  /** The room's current note-taker, if any. */
  current: MeetingNotetaker.nullable(),
  /** False with a plain reason when adding is switched off (the team, the workspace, no server transcriber, or the room is full of listeners). */
  canAdd: z.boolean(),
  reason: z.string().nullable(),
});
export type ListMeetingNotetakersResponse = z.infer<typeof ListMeetingNotetakersResponse>;
export const listMeetingNotetakersRoute = { method: 'GET', path: '/api/meetings/:meetingId/notetakers' } as const satisfies ApiRoute;

export const SetMeetingNotetakerRequest = z.strictObject({ botId: BotId });
export type SetMeetingNotetakerRequest = z.infer<typeof SetMeetingNotetakerRequest>;
export const SetMeetingNotetakerResponse = z.object({ notetaker: MeetingNotetaker });
export type SetMeetingNotetakerResponse = z.infer<typeof SetMeetingNotetakerResponse>;
export const setMeetingNotetakerRoute = { method: 'PUT', path: '/api/meetings/:meetingId/notetaker' } as const satisfies ApiRoute;

export const RemoveMeetingNotetakerResponse = z.object({ removed: z.boolean() });
export type RemoveMeetingNotetakerResponse = z.infer<typeof RemoveMeetingNotetakerResponse>;
export const removeMeetingNotetakerRoute = { method: 'DELETE', path: '/api/meetings/:meetingId/notetaker' } as const satisfies ApiRoute;

export const MeetingNotetakerPathParams = z.object({ meetingId: MeetingId });
export type MeetingNotetakerPathParams = z.infer<typeof MeetingNotetakerPathParams>;
