import { ChannelMessage, ThreadChannelRef, type FileSummary, type ReactionSummary } from '@manythreads/shared';

// The plugin's mapper for the rows it reads (messages with their thread counters, and the channel they sit in). Plugins may not import
// the kernel's mappers nor another plugin's code, so the shape of a `ChannelMessage` is built here from the shared schema.

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** What a deleted message is served as: the row stays so a thread keeps its place, its text does not. */
const DELETED_BODY = '[deleted]';

export const MESSAGE_COLUMNS =
  'm.id, m.workspace_id, m.channel_id, m.author_id, m.body, m.body_plain, m.thread_root_id, m.edited_at, m.deleted_at, m.meta, m.created_at';

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
  reply_count: number | null;
  last_reply_at: Date | null;
};

export const toChannelMessage = (r: MessageRow, reactions: readonly ReactionSummary[], attachments: readonly FileSummary[] = []): ChannelMessage =>
  ChannelMessage.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    authorId: r.author_id,
    body: r.deleted_at ? DELETED_BODY : r.body,
    bodyPlain: r.deleted_at ? '' : r.body_plain,
    threadRootId: r.thread_root_id,
    editedAt: iso(r.edited_at),
    deletedAt: iso(r.deleted_at),
    meta: r.deleted_at ? {} : r.meta,
    createdAt: r.created_at.toISOString(),
    reactions,
    attachments: r.deleted_at ? [] : attachments,
    replyCount: r.reply_count ?? 0,
    lastReplyAt: iso(r.last_reply_at),
  });

export type ChannelRefRow = { channel_id: string; channel_name: string; channel_kind: string; channel_team_id: string | null; channel_private: boolean };
export const CHANNEL_REF_COLUMNS = 'c.id AS channel_id, c.name AS channel_name, c.kind AS channel_kind, c.team_id AS channel_team_id, c.private AS channel_private';
export const toChannelRef = (r: ChannelRefRow): ThreadChannelRef =>
  ThreadChannelRef.parse({ id: r.channel_id, name: r.channel_name, kind: r.channel_kind, teamId: r.channel_team_id, private: r.channel_private });
