import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, ChannelGroupId, ChannelId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

// PLAN.md A.3 channel tables. Enums match the SQL CHECKs in plugins/channels/migrations exactly (a test compares both).

/** A channel name without the `#`: lowercase letters, digits and dashes (the `channels.name` CHECK for `kind = 'channel'`). */
export const ChannelName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase channel name like "dev"');
export type ChannelName = z.infer<typeof ChannelName>;

export const ChannelKind = z.enum(['channel', 'dm', 'bot_conversation']);
export type ChannelKind = z.infer<typeof ChannelKind>;

/** A sidebar group of one team ("Channels", "Product", "Operations"). */
export const ChannelGroup = z.object({
  id: ChannelGroupId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  name: z.string().min(1).max(80),
  position: z.number().int(),
  createdAt: IsoDateTime,
});
export type ChannelGroup = z.infer<typeof ChannelGroup>;

/**
 * A channel, a direct message or a bot conversation. A `channel` belongs to a team (`teamId`), is public to the team unless
 * `private`, and may sit in a group. A `dm` has `dmKey` and no team; a `bot_conversation` has `botId`. Both are private.
 */
export const Channel = z.object({
  id: ChannelId,
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  groupId: ChannelGroupId.nullable(),
  name: z.string(),
  kind: ChannelKind,
  private: z.boolean(),
  purpose: z.string().max(250),
  dmKey: z.string().nullable(),
  botId: BotId.nullable(),
  position: z.number().int(),
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Channel = z.infer<typeof Channel>;

/** One person in a channel: who sees a private channel, and who joined a public one (`muted` silences notifications). */
export const ChannelMember = z.object({
  channelId: ChannelId,
  personId: PersonId,
  muted: z.boolean(),
  createdAt: IsoDateTime,
});
export type ChannelMember = z.infer<typeof ChannelMember>;
