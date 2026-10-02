import { z } from 'zod';
import { Channel, ChannelGroup } from '../../entities/channel.ts';
import { ChannelGroupId, ChannelId, PersonId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';
import { ChannelNameInput, ChannelPurpose } from './common.ts';

// The sidebar's channel directory is `navChannelDirectoryRoute` (GET /api/teams/:slug/channels, surfaces/nav.ts).

/** Create a channel in a team (team lead or workspace admin). A private channel starts with its creator as the only member. */
export const CreateChannelRequest = z.strictObject({
  name: ChannelNameInput,
  purpose: ChannelPurpose.optional(),
  private: z.boolean().optional(),
  groupId: ChannelGroupId.nullable().optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequest>;
export const CreateChannelResponse = z.object({ channel: Channel });
export type CreateChannelResponse = z.infer<typeof CreateChannelResponse>;
export const createChannelRoute = { method: 'POST', path: '/api/teams/:slug/channels' } as const;

export const CreateChannelGroupRequest = z.strictObject({ name: z.string().trim().min(1).max(80) });
export type CreateChannelGroupRequest = z.infer<typeof CreateChannelGroupRequest>;
export const CreateChannelGroupResponse = z.object({ group: ChannelGroup, created: z.boolean() });
export type CreateChannelGroupResponse = z.infer<typeof CreateChannelGroupResponse>;
export const createChannelGroupRoute = { method: 'POST', path: '/api/teams/:slug/channel-groups' } as const;

export const ChannelPathParams = z.object({ channelId: ChannelId });
export type ChannelPathParams = z.infer<typeof ChannelPathParams>;
export const TeamSlugParams = z.object({ slug: TeamSlug });

/** A channel and what the caller may do in it (the composer hides when `canPost` is false). */
export const GetChannelResponse = z.object({
  channel: Channel,
  isMember: z.boolean(),
  canPost: z.boolean(),
  canManage: z.boolean(),
});
export type GetChannelResponse = z.infer<typeof GetChannelResponse>;
export const getChannelRoute = { method: 'GET', path: '/api/channels/:channelId' } as const;

export const UpdateChannelRequest = z
  .strictObject({
    name: ChannelNameInput.optional(),
    purpose: ChannelPurpose.optional(),
    groupId: ChannelGroupId.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequest>;
export const UpdateChannelResponse = z.object({ channel: Channel, changed: z.boolean() });
export type UpdateChannelResponse = z.infer<typeof UpdateChannelResponse>;
export const updateChannelRoute = { method: 'PATCH', path: '/api/channels/:channelId' } as const;

export const ArchiveChannelResponse = z.object({ channel: Channel, changed: z.boolean() });
export type ArchiveChannelResponse = z.infer<typeof ArchiveChannelResponse>;
export const archiveChannelRoute = { method: 'POST', path: '/api/channels/:channelId/archive' } as const;
export const unarchiveChannelRoute = { method: 'POST', path: '/api/channels/:channelId/unarchive' } as const;

export const JoinChannelResponse = z.object({ joined: z.boolean() });
export type JoinChannelResponse = z.infer<typeof JoinChannelResponse>;
export const joinChannelRoute = { method: 'POST', path: '/api/channels/:channelId/join' } as const;

export const LeaveChannelResponse = z.object({ left: z.boolean() });
export type LeaveChannelResponse = z.infer<typeof LeaveChannelResponse>;
export const leaveChannelRoute = { method: 'POST', path: '/api/channels/:channelId/leave' } as const;

export const ChannelMemberItem = z.object({
  personId: PersonId,
  displayName: z.string(),
  muted: z.boolean(),
  joinedAt: z.iso.datetime({ offset: true }),
});
export type ChannelMemberItem = z.infer<typeof ChannelMemberItem>;
export const ListChannelMembersResponse = z.object({ members: z.array(ChannelMemberItem) });
export type ListChannelMembersResponse = z.infer<typeof ListChannelMembersResponse>;
export const listChannelMembersRoute = { method: 'GET', path: '/api/channels/:channelId/members' } as const;

/** Add a person to a channel (team lead or workspace admin); they must be on the channel's team. */
export const AddChannelMemberRequest = z.strictObject({ personId: PersonId });
export type AddChannelMemberRequest = z.infer<typeof AddChannelMemberRequest>;
export const AddChannelMemberResponse = z.object({ added: z.boolean() });
export type AddChannelMemberResponse = z.infer<typeof AddChannelMemberResponse>;
export const addChannelMemberRoute = { method: 'POST', path: '/api/channels/:channelId/members' } as const;

export const ChannelMemberPathParams = z.object({ channelId: ChannelId, personId: PersonId });
export const RemoveChannelMemberResponse = z.object({ removed: z.boolean() });
export type RemoveChannelMemberResponse = z.infer<typeof RemoveChannelMemberResponse>;
export const removeChannelMemberRoute = { method: 'DELETE', path: '/api/channels/:channelId/members/:personId' } as const;
