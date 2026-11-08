import { z } from 'zod';
import { MeetingShare } from '../../entities/meeting.ts';
import { ChannelId, MeetingId, MeetingShareId, PersonId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Sharing a meeting's notes (PLAN P15-22). The organizer shares with a person or with a channel; either can be taken back. A reader's access is checked again on every
// read (a person who left the team no longer reads), and the notes and the transcript are served by the meetings plugin, not through the file's own access.

export const MeetingSharePathParams = z.object({ meetingId: MeetingId, shareId: MeetingShareId });
export type MeetingSharePathParams = z.infer<typeof MeetingSharePathParams>;

export const ListMeetingSharesResponse = z.object({ shares: z.array(MeetingShare) });
export type ListMeetingSharesResponse = z.infer<typeof ListMeetingSharesResponse>;
export const listMeetingSharesRoute = { method: 'GET', path: '/api/meetings/:meetingId/shares' } as const satisfies ApiRoute;

export const CreateMeetingShareRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), personId: PersonId }),
  z.strictObject({ kind: z.literal('channel'), channelId: ChannelId }),
]);
export type CreateMeetingShareRequest = z.infer<typeof CreateMeetingShareRequest>;
export const CreateMeetingShareResponse = z.object({ share: MeetingShare });
export type CreateMeetingShareResponse = z.infer<typeof CreateMeetingShareResponse>;
export const createMeetingShareRoute = { method: 'POST', path: '/api/meetings/:meetingId/shares' } as const satisfies ApiRoute;

export const DeleteMeetingShareResponse = z.object({ share: MeetingShare });
export type DeleteMeetingShareResponse = z.infer<typeof DeleteMeetingShareResponse>;
export const deleteMeetingShareRoute = { method: 'DELETE', path: '/api/meetings/:meetingId/shares/:shareId' } as const satisfies ApiRoute;
