import { z } from 'zod';
import {
  CALL_CARDS_MAX,
  CALL_INVITES_MAX,
  CallCard,
  CallInvitee,
  Meeting,
  MeetingJoin,
  MeetingKind,
  MeetingNotetakerBot,
  MeetingState,
  MeetingSummary,
  MeetingTitle,
} from '../../entities/meeting.ts';
import { Team } from '../../entities/team.ts';
import { BotId, ChannelId, MeetingId, PersonId } from '../../ids.ts';
import { GuestLinkMade } from './guests.ts';

export * from './consent.ts';
export * from './segments.ts';
export * from './notes.ts';
export * from './notetaker.ts';
export * from './shares.ts';
export * from './recording.ts';
export * from './audio.ts';
export * from './search.ts';
export * from './scheduled.ts';
export * from './share-requests.ts';
export * from './guests.ts';
import type { ApiRoute } from '../client/route.ts';

// Voice rooms (PLAN P15-03, plugin `meetings`, docs/plugins/meetings.md). One live room per channel; a DM call uses the DM's channel. Whoever may read the channel may
// join; whoever may post there may start one. A room closes when its starter, a lead of the team or a workspace admin ends it, or by itself two minutes after the last
// person left. When the server has no media server set up, start, join and token answer 409 with a plain message and `GET /api/meetings/media-status` says why.

const TeamSlug = Team.shape.slug;

export const MeetingPathParams = z.object({ meetingId: MeetingId });
export type MeetingPathParams = z.infer<typeof MeetingPathParams>;

export const StartMeetingPathParams = z.object({ channelId: ChannelId });
export type StartMeetingPathParams = z.infer<typeof StartMeetingPathParams>;

/**
 * Start a call in a channel (P15-25). Every field is optional (an older page sends `{ title }` only). The title defaults to "Call · #dev · 14:02" ("Call · 14:02" in a
 * direct message; the time in UTC). `kind` defaults to `audio` (`video` is a video call, P36-02). `inviteeIds` are people asked to the
 * call (each must be able to read the channel, or the whole start is refused with 403; the caller is left out; ignored in a direct message, where everyone is rung).
 * `allowGuests: true` turns guest links on for a new call (P17-04): the starter's first link is made in the same transaction and its address returned once (`guestLink`). `notetakerBotId` adds that note-taker as the call opens; when it cannot be added the start answers 409
 * (or 403 for a switch somebody turned off) with the reason and nothing is written. Asking again while a call is live only joins it (`created: false`, nobody invited).
 */
export const StartMeetingRequest = z.strictObject({
  title: MeetingTitle.optional(),
  kind: MeetingKind.optional(),
  inviteeIds: z.array(PersonId).max(CALL_INVITES_MAX).optional(),
  allowGuests: z.boolean().optional(),
  notetakerBotId: BotId.nullable().optional(),
});
export type StartMeetingRequest = z.infer<typeof StartMeetingRequest>;
export const StartMeetingResponse = z.object({
  meeting: Meeting,
  /** True when this call opened the room; false when one was already live and the caller joined it. */
  created: z.boolean(),
  join: MeetingJoin,
  /** How many people this start asked to the call (0 when it joined a call that was already going). */
  invited: z.number().int().min(0).default(0),
  /** The starter's guest link when the call opened with guest links on (P17-04): shown once, never stored in the clear. Null otherwise. */
  guestLink: GuestLinkMade.nullable().default(null),
});
export type StartMeetingResponse = z.infer<typeof StartMeetingResponse>;
export const startMeetingRoute = { method: 'POST', path: '/api/channels/:channelId/meetings' } as const satisfies ApiRoute;

/**
 * What the start dialog offers in a channel (P15-25). `canStart` is false with a plain reason for a person who may not post there, and `people` is then empty. `live` is the
 * call already going (the dialog joins it instead). `people` are the readers of the channel (in a direct message its people), the caller first; a guest sees only themself;
 * at most 200 are sent (`peopleTotal` says how many match) and `?q=` narrows them by name or handle.
 * `notetaker` says which bots may take notes here and whether one may be added now (false with the reason when not). Guest links are not built yet.
 */
/** At most this many people the start dialog is sent at once; `peopleTotal` says how many match, and `q` narrows the list on the server. */
export const CALL_OPTIONS_PEOPLE_MAX = 200;

/** `q`: a name (the start of any word of it) or a handle (the start of the e-mail address) to narrow the people offered; at most 80 characters. */
export const CallStartOptionsQuery = z.object({ q: z.string().trim().max(80).optional() });
export type CallStartOptionsQuery = z.infer<typeof CallStartOptionsQuery>;

export const CallStartOptionsResponse = z.object({
  canStart: z.boolean(),
  reason: z.string().nullable(),
  /** True in a direct message: everyone in it is rung, so the dialog shows no list. */
  directMessage: z.boolean(),
  /** The title the dialog fills in. */
  defaultTitle: z.string(),
  live: z.object({ meetingId: MeetingId, title: z.string() }).nullable(),
  /** The first 200 readers that match `q` (all of them without it), the caller first and always there. */
  people: z.array(CallInvitee).max(CALL_OPTIONS_PEOPLE_MAX),
  /** How many readers match `q` in all, the caller included, so the dialog can say "showing 200 of 1,240: type to search". */
  peopleTotal: z.number().int().min(0),
  notetaker: z.object({
    bots: z.array(MeetingNotetakerBot),
    defaultBotId: BotId.nullable(),
    available: z.boolean(),
    reason: z.string().nullable(),
  }),
  /** Whether a call here may let people outside the workspace join with a link (P17-04); false with the reason in a direct message, when the workspace switch is off, for a workspace guest, or with no media server. */
  guestLinks: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
export type CallStartOptionsResponse = z.infer<typeof CallStartOptionsResponse>;
export const callStartOptionsRoute = { method: 'GET', path: '/api/channels/:channelId/calls/options' } as const satisfies ApiRoute;

/**
 * Ask more people to a live call ("Invite more", P15-27): whoever may post in the channel. Each person must be able to read the channel, or nothing is done (403). People
 * already asked, and the caller, are left out; `invited` are the ones newly asked. Not in a direct message (everyone there was rung).
 */
export const InviteToMeetingRequest = z.strictObject({ personIds: z.array(PersonId).min(1).max(CALL_INVITES_MAX) });
export type InviteToMeetingRequest = z.infer<typeof InviteToMeetingRequest>;
export const InviteToMeetingResponse = z.object({ invited: z.array(PersonId) });
export type InviteToMeetingResponse = z.infer<typeof InviteToMeetingResponse>;
export const inviteToMeetingRoute = { method: 'POST', path: '/api/meetings/:meetingId/invites' } as const satisfies ApiRoute;

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
export const MeetingHeartbeatResponse = z.object({
  ok: z.literal(true),
  /** The server's clock (ISO time). The device keeps the difference to its own clock, so `startMs` of a line is on the meeting clock whatever the device's clock says. */
  serverNow: z.iso.datetime({ offset: true }),
});
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

/**
 * The cards of some calls (P15-26): the web asks for the calls whose start messages are in view (`meta.meeting`), ids joined by commas, at most 50. A call the caller cannot
 * read is left out of the answer, never an error. The comma list is turned into an array before the check, and an array passes unchanged.
 */
export const ListCallCardsQuery = z.object({
  ids: z.preprocess(
    (value) =>
      typeof value === 'string' && value.length <= CALL_CARDS_MAX * 37
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '')
        : value,
    z.array(MeetingId).min(1).max(CALL_CARDS_MAX),
  ),
});
export type ListCallCardsQuery = { ids: string };
export const ListCallCardsResponse = z.object({ cards: z.array(CallCard) });
export type ListCallCardsResponse = z.infer<typeof ListCallCardsResponse>;
export const listCallCardsRoute = { method: 'GET', path: '/api/meetings/cards' } as const satisfies ApiRoute;

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

/**
 * Meetings without a channel (P36-03, docs/plans/meetings-without-a-channel.md): a meeting space is a team-less private channel of kind `meeting` whose members are
 * the person who opens it and the people invited, from any team. Opening one starts its call at once (the invited are told as for any call).
 */
export const OpenMeetingSpaceRequest = z.strictObject({
  title: MeetingTitle,
  /** The team the meeting is for (the caller must be on it); its people may come from any team. */
  teamSlug: Team.shape.slug,
  kind: MeetingKind.optional(),
  inviteeIds: z.array(PersonId).max(CALL_INVITES_MAX).default([]),
});
export type OpenMeetingSpaceRequest = z.input<typeof OpenMeetingSpaceRequest>;
export const OpenMeetingSpaceResponse = StartMeetingResponse.extend({ channelId: ChannelId });
export type OpenMeetingSpaceResponse = z.infer<typeof OpenMeetingSpaceResponse>;
export const openMeetingSpaceRoute = { method: 'POST', path: '/api/meetings/spaces' } as const;

export const MeetingSpace = z.object({
  channelId: ChannelId,
  title: z.string(),
  /** The team it is for (null when that team is gone). */
  teamId: z.string().nullable(),
  createdAt: z.string(),
  /** How many people are in the space. */
  memberCount: z.number().int(),
  /** The call that is live in it now, if any. */
  liveMeetingId: MeetingId.nullable(),
});
export type MeetingSpace = z.infer<typeof MeetingSpace>;
export const ListMeetingSpacesResponse = z.object({ spaces: z.array(MeetingSpace) });
export type ListMeetingSpacesResponse = z.infer<typeof ListMeetingSpacesResponse>;
export const listMeetingSpacesRoute = { method: 'GET', path: '/api/meetings/spaces' } as const;

/** Who can be invited to a meeting (P36-03): active people of the workspace who are not guests, from every team, by name; at most 50, the caller left out. */
export const MeetingPeopleQuery = z.object({ q: z.string().trim().max(80).default('') });
export const MeetingPerson = z.object({ personId: PersonId, name: z.string() });
export type MeetingPerson = z.infer<typeof MeetingPerson>;
export const MeetingPeopleResponse = z.object({ people: z.array(MeetingPerson) });
export type MeetingPeopleResponse = z.infer<typeof MeetingPeopleResponse>;
export const meetingPeopleRoute = { method: 'GET', path: '/api/meetings/people' } as const;
export * from './appointments.ts';
export * from './series.ts';
export * from './assistant.ts';
export * from './review.ts';
