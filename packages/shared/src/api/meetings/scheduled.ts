import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import {
  SCHEDULED_AGENDA_MAX,
  SCHEDULED_ATTENDEES_MAX,
  SCHEDULED_MAX_HOURS,
  ScheduledMeeting,
  ScheduledMeetingGate,
  ScheduledMeetingProvider,
  ScheduledMeetingTitle,
} from '../../entities/scheduled-meeting.ts';
import { Meeting, MeetingJoin } from '../../entities/meeting.ts';
import { ChannelId, PersonId, ScheduledMeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Rooms planned ahead on a person's calendar (PLAN Bundle D, P16-05, plugin `meetings`). The organizer plans a room in a channel: the plan is an event at their own Google
// or Microsoft calendar with the join link `/join/<id>` in it, and a row here. Readers of the channel read the plan; only its organizer changes or cancels it. A plan is
// not a room: the room is made by `POST /api/scheduled-meetings/:id/join` (Start at the time, or the link). Outside people are counted, never stored. docs/plugins/meetings.md.

export const ScheduledMeetingPathParams = z.object({ scheduledMeetingId: ScheduledMeetingId });
export type ScheduledMeetingPathParams = z.infer<typeof ScheduledMeetingPathParams>;
export const ScheduledMeetingsChannelParams = z.object({ channelId: ChannelId });
export type ScheduledMeetingsChannelParams = z.infer<typeof ScheduledMeetingsChannelParams>;

/** An ISO time with its offset, as the person's browser sends it ("2026-11-09T15:00:00+03:00"); the server stores UTC. */
export const ScheduledStartsAt = IsoDateTime;
export const ScheduledLengthMinutes = z.number().int().min(15).max(SCHEDULED_MAX_HOURS * 60);

export const CreateScheduledMeetingRequest = z
  .strictObject({
    title: ScheduledMeetingTitle,
    startsAt: ScheduledStartsAt,
    lengthMinutes: ScheduledLengthMinutes,
    agendaMd: z.string().max(SCHEDULED_AGENDA_MAX).default(''),
    /** Which of the organizer's calendars carries the event; left out, the connected service's main calendar. */
    calendarProvider: ScheduledMeetingProvider.optional(),
    calendarId: z.string().min(1).max(500).optional(),
    /** People of the workspace who are in the channel. */
    attendeePersonIds: z.array(PersonId).max(SCHEDULED_ATTENDEES_MAX).default([]),
    /** People outside the workspace, by address. Used for the invitation and then forgotten: only their number is kept. */
    outsideAddresses: z.array(z.email().max(320)).max(SCHEDULED_ATTENDEES_MAX).default([]),
  })
  .refine((v) => v.attendeePersonIds.length + v.outsideAddresses.length <= SCHEDULED_ATTENDEES_MAX, { message: `At most ${SCHEDULED_ATTENDEES_MAX} people can be invited`, path: ['attendeePersonIds'] });
export type CreateScheduledMeetingRequest = z.infer<typeof CreateScheduledMeetingRequest>;
export const CreateScheduledMeetingResponse = z.object({ scheduledMeeting: ScheduledMeeting });
export type CreateScheduledMeetingResponse = z.infer<typeof CreateScheduledMeetingResponse>;
export const createScheduledMeetingRoute = { method: 'POST', path: '/api/channels/:channelId/scheduled-meetings' } as const satisfies ApiRoute;

/** `upcoming=1`: only the next one that is live or starts within 12 hours (the channel header chip). Otherwise the waiting plans, soonest first. */
export const ListScheduledMeetingsQuery = z.object({
  upcoming: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListScheduledMeetingsQuery = z.infer<typeof ListScheduledMeetingsQuery>;
export const ListScheduledMeetingsResponse = z.object({ scheduledMeetings: z.array(ScheduledMeeting) });
export type ListScheduledMeetingsResponse = z.infer<typeof ListScheduledMeetingsResponse>;
export const listScheduledMeetingsRoute = { method: 'GET', path: '/api/channels/:channelId/scheduled-meetings' } as const satisfies ApiRoute;

/** What `/join/:id` needs: the plan when the caller may read its channel, and the gate sentence data when not. A cancelled plan answers its status. */
export const GetScheduledMeetingResponse = z.object({ gate: ScheduledMeetingGate, scheduledMeeting: ScheduledMeeting.nullable() });
export type GetScheduledMeetingResponse = z.infer<typeof GetScheduledMeetingResponse>;
export const getScheduledMeetingRoute = { method: 'GET', path: '/api/scheduled-meetings/:scheduledMeetingId' } as const satisfies ApiRoute;

export const UpdateScheduledMeetingRequest = z
  .strictObject({
    title: ScheduledMeetingTitle.optional(),
    startsAt: ScheduledStartsAt.optional(),
    lengthMinutes: ScheduledLengthMinutes.optional(),
    agendaMd: z.string().max(SCHEDULED_AGENDA_MAX).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one thing' });
export type UpdateScheduledMeetingRequest = z.infer<typeof UpdateScheduledMeetingRequest>;
export const UpdateScheduledMeetingResponse = z.object({ scheduledMeeting: ScheduledMeeting });
export type UpdateScheduledMeetingResponse = z.infer<typeof UpdateScheduledMeetingResponse>;
export const updateScheduledMeetingRoute = { method: 'PATCH', path: '/api/scheduled-meetings/:scheduledMeetingId' } as const satisfies ApiRoute;

/** Cancelling also cancels the event at the organizer's calendar. */
export const CancelScheduledMeetingResponse = z.object({ scheduledMeeting: ScheduledMeeting });
export type CancelScheduledMeetingResponse = z.infer<typeof CancelScheduledMeetingResponse>;
export const cancelScheduledMeetingRoute = { method: 'DELETE', path: '/api/scheduled-meetings/:scheduledMeetingId' } as const satisfies ApiRoute;

/** Opens the room of the plan, or joins it when one is live (`created: false`); only a reader of the channel who may post can open it. */
export const JoinScheduledMeetingResponse = z.object({ meeting: Meeting, created: z.boolean(), join: MeetingJoin });
export type JoinScheduledMeetingResponse = z.infer<typeof JoinScheduledMeetingResponse>;
export const joinScheduledMeetingRoute = { method: 'POST', path: '/api/scheduled-meetings/:scheduledMeetingId/join' } as const satisfies ApiRoute;

// ---- Live push over the socket ----------------------------------------------------------------------------------------------------------------------
/** Pushed to everyone who can read the plan's channel when a plan is made, changed, cancelled or opened as a room: the channel header asks `GET /api/channels/:id/scheduled-meetings?upcoming=1` again. Ids only. */
export const SCHEDULED_MEETING_CHANGED_PUSH = 'scheduled_meeting.changed';
export const ScheduledMeetingChangedPush = z.object({
  scheduledMeetingId: ScheduledMeetingId,
  channelId: ChannelId,
  change: z.enum(['created', 'changed', 'cancelled', 'started']),
});
export type ScheduledMeetingChangedPush = z.infer<typeof ScheduledMeetingChangedPush>;
