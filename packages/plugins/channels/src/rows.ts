import {
  Channel,
  ChannelGroup,
  ChannelMember,
  ChannelMessage,
  Mention,
  Message,
  Reaction,
  Thread,
  ThreadFollow,
  type FileSummary,
  type ReactionSummary,
} from '@manythreads/shared';
import { DELETED_BODY } from './plain.ts';

// Plugins may not import the kernel's mappers, so this file is the plugin's mapper for each of its tables: the only place a row of
// channel_groups, channels, channel_members, messages, message_reactions, message_mentions, threads or thread_follows becomes a
// shared entity. Dates are converted here, once.

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export type ChannelGroupRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  position: number;
  created_at: Date;
};
export const GROUP_COLUMNS = 'g.id, g.workspace_id, g.team_id, g.name, g.position, g.created_at';
export const toChannelGroup = (r: ChannelGroupRow): ChannelGroup =>
  ChannelGroup.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    position: r.position,
    createdAt: r.created_at.toISOString(),
  });

export type ChannelRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  group_id: string | null;
  name: string;
  kind: string;
  private: boolean;
  purpose: string;
  dm_key: string | null;
  bot_id: string | null;
  position: number;
  archived_at: Date | null;
  created_at: Date;
};
export const CHANNEL_COLUMNS =
  'c.id, c.workspace_id, c.team_id, c.group_id, c.name, c.kind, c.private, c.purpose, c.dm_key, c.bot_id, c.position, c.archived_at, c.created_at';
export const toChannel = (r: ChannelRow): Channel =>
  Channel.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    groupId: r.group_id,
    name: r.name,
    kind: r.kind,
    private: r.private,
    purpose: r.purpose,
    dmKey: r.dm_key,
    botId: r.bot_id,
    position: r.position,
    archivedAt: iso(r.archived_at),
    createdAt: r.created_at.toISOString(),
  });

export type ChannelMemberRow = { channel_id: string; person_id: string; muted: boolean; created_at: Date };
export const toChannelMember = (r: ChannelMemberRow): ChannelMember =>
  ChannelMember.parse({ channelId: r.channel_id, personId: r.person_id, muted: r.muted, createdAt: r.created_at.toISOString() });

export type MessageRow = {
  id: string;
  workspace_id: string;
  channel_id: string;
  author_id: string;
  body: string;
  body_plain: string;
  thread_root_id: string | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  meta: Record<string, unknown>;
  created_at: Date;
};
export const MESSAGE_COLUMNS =
  'm.id, m.workspace_id, m.channel_id, m.author_id, m.body, m.body_plain, m.thread_root_id, m.edited_at, m.deleted_at, m.meta, m.created_at';

/** A deleted message keeps its row but not its text: the body is a fixed tombstone and the plain text is empty. */
const messageFields = (r: MessageRow) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  channelId: r.channel_id,
  authorId: r.author_id,
  body: r.deleted_at ? DELETED_BODY : r.body,
  bodyPlain: r.deleted_at ? '' : r.body_plain,
  threadRootId: r.thread_root_id,
  editedAt: iso(r.edited_at),
  deletedAt: iso(r.deleted_at),
  meta: r.deleted_at ? {} : r.meta,   // attachment ids go with the text
  createdAt: r.created_at.toISOString(),
});
export const toMessage = (r: MessageRow): Message => Message.parse(messageFields(r));

export type MessageWithThreadRow = MessageRow & { reply_count: number | null; last_reply_at: Date | null };
export const toChannelMessage = (
  r: MessageWithThreadRow,
  reactions: readonly ReactionSummary[],
  attachments: readonly FileSummary[] = [],
): ChannelMessage =>
  ChannelMessage.parse({
    ...messageFields(r),
    reactions,
    attachments: r.deleted_at ? [] : attachments,   // a deleted message shows no cards
    replyCount: r.reply_count ?? 0,
    lastReplyAt: iso(r.last_reply_at),
  });

export type ReactionRow = { message_id: string; actor_id: string; emoji: string; created_at: Date };
export const toReaction = (r: ReactionRow): Reaction =>
  Reaction.parse({ messageId: r.message_id, actorId: r.actor_id, emoji: r.emoji, createdAt: r.created_at.toISOString() });

export type MentionRow = { message_id: string; mentioned_id: string; kind: string; created_at: Date };
export const toMention = (r: MentionRow): Mention =>
  Mention.parse({ messageId: r.message_id, mentionedId: r.mentioned_id, kind: r.kind, createdAt: r.created_at.toISOString() });

export type ThreadRow = { root_message_id: string; channel_id: string; title: string; reply_count: number; last_reply_at: Date };
export const toThread = (r: ThreadRow): Thread =>
  Thread.parse({
    rootMessageId: r.root_message_id,
    channelId: r.channel_id,
    title: r.title,
    replyCount: r.reply_count,
    lastReplyAt: r.last_reply_at.toISOString(),
  });

export type ThreadFollowRow = { person_id: string; thread_root_id: string; created_at: Date };
export const toThreadFollow = (r: ThreadFollowRow): ThreadFollow =>
  ThreadFollow.parse({ personId: r.person_id, threadRootId: r.thread_root_id, createdAt: r.created_at.toISOString() });
