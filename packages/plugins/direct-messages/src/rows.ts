import { Channel, DirectMessageSummary } from '@manythreads/shared';

// The plugin's mapper for the rows it reads: a DM channel with its last message, unread count and participants.

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export type DmRow = {
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
  lm_id: string | null;
  lm_author: string | null;
  lm_preview: string | null;
  lm_created: Date | null;
  unread: number;
  sort_key: string;
  participants: Array<{ personId: string; displayName: string }> | null;
};

export const toChannel = (r: DmRow): Channel =>
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

export const toSummary = (r: DmRow): DirectMessageSummary =>
  DirectMessageSummary.parse({
    channel: toChannel(r),
    participants: r.participants ?? [],
    lastMessage: r.lm_id
      ? { id: r.lm_id, authorId: r.lm_author, preview: r.lm_preview ?? '', createdAt: iso(r.lm_created) }
      : null,
    unreadCount: r.unread,
  });
