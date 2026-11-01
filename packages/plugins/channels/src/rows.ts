import {
  Channel,
  ChannelGroup,
  ChannelMember,
  ChannelMessage,
  Mention,
  PollView,
  Message,
  type ForwardedMessage,
  type MessageAuthor,
  Reaction,
  CustomEmoji,
  MessageDraft,
  ScheduledMessage,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The thread a channel message was also sent from (`meta.alsoSentFrom.threadRootId`), if it is such a copy. */
export const alsoSentFromThreadOf = (meta: Record<string, unknown>): string | undefined => {
  const f = meta['alsoSentFrom'];
  if (typeof f !== 'object' || f === null) return undefined;
  const id = (f as Record<string, unknown>)['threadRootId'];
  return typeof id === 'string' && UUID.test(id) ? id : undefined;
};

export type MessageWithThreadRow = MessageRow & { reply_count: number | null; last_reply_at: Date | null };
export const toChannelMessage = (
  r: MessageWithThreadRow,
  reactions: readonly ReactionSummary[],
  attachments: readonly FileSummary[] = [],
  author?: MessageAuthor,
  forward?: ForwardedMessage,
  poll?: PollView,
): ChannelMessage => {
  const alsoSentFromThread = r.deleted_at ? undefined : alsoSentFromThreadOf(r.meta);
  return ChannelMessage.parse({
    ...messageFields(r),
    ...(author ? { author } : {}),
    ...(forward ? { forward } : {}),
    ...(poll && !r.deleted_at ? { poll } : {}),
    ...(alsoSentFromThread ? { alsoSentFromThread } : {}),
    reactions,
    attachments: r.deleted_at ? [] : attachments,   // a deleted message shows no cards
    replyCount: r.reply_count ?? 0,
    lastReplyAt: iso(r.last_reply_at),
  });
};

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

export type ScheduledRow = {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  body: string;
  send_at: Date;
  state: string;
  refused_reason: string | null;
  refused_at: Date | null;
  created_at: Date;
  /** The writer agreed to tell a big room with `@channel` / `@here` (kept for the job; not shown to the client). */
  broadcast_confirmed: boolean;
};
export const SCHEDULED_COLUMNS = 'id, channel_id, thread_root_id, body, send_at, state, refused_reason, refused_at, created_at, broadcast_confirmed';
export const toScheduledMessage = (r: ScheduledRow): ScheduledMessage =>
  ScheduledMessage.parse({
    id: r.id,
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    body: r.body,
    sendAt: r.send_at.toISOString(),
    state: r.state,
    refusedReason: r.refused_reason,
    refusedAt: iso(r.refused_at),
    createdAt: r.created_at.toISOString(),
  });

/** A custom emoji without its bytes (the list and the answer to an add); the picture is read by its own route. */
export type CustomEmojiRow = { id: string; name: string; content_type: string; size: string | number; created_by: string | null; created_at: Date };
export const CUSTOM_EMOJI_COLUMNS = 'id, name, content_type, octet_length(bytes) AS size, created_by, created_at';
export const toCustomEmoji = (r: CustomEmojiRow): CustomEmoji =>
  CustomEmoji.parse({ id: r.id, name: r.name, contentType: r.content_type, size: Number(r.size), createdBy: r.created_by, createdAt: r.created_at.toISOString() });

export type DraftRow = { channel_id: string; thread_root_id: string | null; body: string; updated_at: Date };
export const DRAFT_COLUMNS = 'channel_id, thread_root_id, body, updated_at';
export const toMessageDraft = (r: DraftRow): MessageDraft =>
  MessageDraft.parse({ channelId: r.channel_id, threadRootId: r.thread_root_id, body: r.body, updatedAt: r.updated_at.toISOString() });

/** A poll with the reader's own ballot (`mine`, null when they have not voted) and whether it counts as closed now (the database's clock decides). */
export type PollRow = {
  id: string;
  workspace_id: string;
  channel_id: string;
  message_id: string;
  author_id: string;
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  closes_at: Date | null;
  closed_at: Date | null;
  result_message_id: string | null;
  vote_counts: number[];
  voter_count: number;
  version: number;
  closed: boolean;
  mine: number[] | null;
};
/** The columns of a poll; the query says `FROM app.polls p LEFT JOIN app.poll_votes mv ON ...` (`POLL_MINE_JOIN`) to find the reader's own ballot. */
export const POLL_SELECT =
  'p.id, p.workspace_id, p.channel_id, p.message_id, p.author_id, p.question, p.options, p.multiple, p.anonymous, p.closes_at, p.closed_at, p.result_message_id, p.vote_counts, p.voter_count, p.version, ' +
  '(p.closed_at IS NOT NULL OR (p.closes_at IS NOT NULL AND p.closes_at <= now())) AS closed, mv.choices AS mine';
export const POLL_MINE_JOIN = 'LEFT JOIN app.poll_votes mv ON mv.poll_id = p.id AND mv.voter_id = app.actor()';
export const toPollView = (r: PollRow): PollView =>
  PollView.parse({
    id: r.id,
    question: r.question,
    options: r.options.map((text, i) => ({ text, votes: r.vote_counts[i] ?? 0 })),
    anonymous: r.anonymous,
    multiple: r.multiple,
    closesAt: iso(r.closes_at),
    closed: r.closed,
    closedAt: iso(r.closed_at),
    voters: r.voter_count,
    version: r.version,
    mine: r.mine ?? [],
    resultMessageId: r.result_message_id,
  });
