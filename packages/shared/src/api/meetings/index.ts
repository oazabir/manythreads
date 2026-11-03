import { z } from 'zod';
import { Meeting, MeetingJoin, MeetingState, MeetingSummary, MeetingTitle } from '../../entities/meeting.ts';
import { Team } from '../../entities/team.ts';
import { ChannelId, MeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Voice rooms (PLAN P15-03, plugin `meetings`, docs/plugins/meetings.md). One live room per channel; a DM call uses the DM's channel. Whoever may read the channel may
// join; whoever may post there may start one. A room closes when its starter, a lead of the team or a workspace admin ends it, or by itself two minutes after the last
// person left. When the server has no media server set up, start, join and token answer 409 with a plain message and `GET /api/meetings/media-status` says why.

const TeamSlug = Team.shape.slug;

export const MeetingPathParams = z.object({ meetingId: MeetingId });
export type MeetingPathParams = z.infer<typeof MeetingPathParams>;

export const StartMeetingPathParams = z.object({ channelId: ChannelId });
export type StartMeetingPathParams = z.infer<typeof StartMeetingPathParams>;

/** Start a room in a channel. The title defaults to "Voice room · 14:02" (the time in UTC). Asking again while a room is live joins that one (`created: false`). */
export const StartMeetingRequest = z.strictObject({ title: MeetingTitle.optional() });
export type StartMeetingRequest = z.infer<typeof StartMeetingRequest>;
export const StartMeetingResponse = z.object({
  meeting: Meeting,
  /** True when this call opened the room; false when one was already live and the caller joined it. */
  created: z.boolean(),
  join: MeetingJoin,
});
export type StartMeetingResponse = z.infer<typeof StartMeetingResponse>;
export const startMeetingRoute = { method: 'POST', path: '/api/channels/:channelId/meetings' } as const satisfies ApiRoute;

export const JoinMeetingResponse = z.object({ meeting: Meeting, join: MeetingJoin });
export type JoinMeetingResponse = z.infer<typeof JoinMeetingResponse>;
export const joinMeetingRoute = { method: 'POST', path: '/api/meetings/:meetingId/join' } as const satisfies ApiRoute;

/** A new token for someone already in the room, while they may still read the channel (the old one lasts at most ten minutes). */
export const RenewMeetingTokenResponse = z.object({ join: MeetingJoin });
export type RenewMeetingTokenResponse = z.infer<typeof RenewMeetingTokenResponse>;
export const renewMeetingTokenRoute = { method: 'POST', path: '/api/meetings/:meetingId/token' } as const satisfies ApiRoute;

export const LeaveMeetingResponse = z.object({ meeting: Meeting });
export type LeaveMeetingResponse = z.infer<typeof LeaveMeetingResponse>;
export const leaveMeetingRoute = { method: 'POST', path: '/api/meetings/:meetingId/leave' } as const satisfies ApiRoute;

export const EndMeetingResponse = z.object({ meeting: Meeting });
export type EndMeetingResponse = z.infer<typeof EndMeetingResponse>;
export const endMeetingRoute = { method: 'POST', path: '/api/meetings/:meetingId/end' } as const satisfies ApiRoute;

export const GetMeetingResponse = MeetingSummary;
export type GetMeetingResponse = z.infer<typeof GetMeetingResponse>;
export const getMeetingRoute = { method: 'GET', path: '/api/meetings/:meetingId' } as const satisfies ApiRoute;

/** The room page says "I am still here" every 30 seconds and whether the person is speaking; a person silent for three minutes is counted as gone. */
export const MeetingHeartbeatRequest = z.strictObject({ speaking: z.boolean().default(false) });
export type MeetingHeartbeatRequest = z.infer<typeof MeetingHeartbeatRequest>;
export const MeetingHeartbeatResponse = z.object({ ok: z.literal(true) });
export type MeetingHeartbeatResponse = z.infer<typeof MeetingHeartbeatResponse>;
export const heartbeatMeetingRoute = { method: 'POST', path: '/api/meetings/:meetingId/heartbeat' } as const satisfies ApiRoute;

export const ListTeamMeetingsPathParams = z.object({ slug: TeamSlug });
export type ListTeamMeetingsPathParams = z.infer<typeof ListTeamMeetingsPathParams>;
export const ListMeetingsQuery = z.object({
  state: MeetingState.default('live'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMeetingsQuery = z.infer<typeof ListMeetingsQuery>;
export const ListMeetingsResponse = z.object({ meetings: z.array(MeetingSummary) });
export type ListMeetingsResponse = z.infer<typeof ListMeetingsResponse>;
export const listTeamMeetingsRoute = { method: 'GET', path: '/api/teams/:slug/meetings' } as const satisfies ApiRoute;
/** Every live room the caller can read, in any team and in their direct messages (the sidebar badge, an incoming DM call). */
export const listMyLiveMeetingsRoute = { method: 'GET', path: '/api/meetings/live' } as const satisfies ApiRoute;

/** Whether the server can make calls: false with a plain reason (and what to do) when no media server is set up. */
export const MediaStatusResponse = z.object({
  configured: z.boolean(),
  /** The provider that would carry calls, or null when none is loaded. */
  provider: z.string().nullable(),
  /** Plain words for a person; null when everything works. */
  reason: z.string().nullable(),
});
export type MediaStatusResponse = z.infer<typeof MediaStatusResponse>;
export const mediaStatusRoute = { method: 'GET', path: '/api/meetings/media-status' } as const satisfies ApiRoute;

/** The media server's signed notices (a person connected or dropped, a room closed). Public: the signature is the credential. The body is the provider's own JSON. */
export const mediaWebhookRoute = { method: 'POST', path: '/api/meetings/media-webhook' } as const satisfies ApiRoute;
