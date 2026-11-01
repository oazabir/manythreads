import { z } from 'zod';
import { ChannelId } from '../../ids.ts';

/**
 * The role groups the `@` picker offers in one conversation (P14-03): the team's role tags that count as mention handles (a person or a bot with the
 * same word wins, see `roleGroups`), each with how many people a mention would reach there, which is the holders of the tag who can read this channel.
 * A group nobody there holds is left out. A conversation with no team, and a caller who is not on the team (a guest), get an empty list.
 */
export const MentionGroup = z.object({
  /** The word after `@`, lower case: `on-call`. */
  handle: z.string(),
  /** The role tag it comes from: `role:on-call`. */
  tag: z.string(),
  /** People a mention reaches in this conversation, the caller included. */
  memberCount: z.number().int().positive(),
});
export type MentionGroup = z.infer<typeof MentionGroup>;

export const ListMentionGroupsResponse = z.object({ groups: z.array(MentionGroup) });
export type ListMentionGroupsResponse = z.infer<typeof ListMentionGroupsResponse>;
export const listMentionGroupsRoute = { method: 'GET', path: '/api/channels/:channelId/mention-groups' } as const;
export const MentionGroupsPathParams = z.object({ channelId: ChannelId });
