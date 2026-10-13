import { Conversation, ConversationListItem } from '@manythreads/shared';

// The plugin's mappers (PLAN B: one mapper per table; a plugin cannot import the kernel's, so they live here, as in the bots plugin).
// `toConversation` is the one place a row of `app.conversations` becomes the shared entity; `toListItem` maps the lists' rows, which are the
// thread's own facts joined to what the caller may read of it (nothing in them is a copy stored on `conversations`).

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** A row of `app.conversations`. */
export type ConversationRow = {
  thread_root_id: string;
  workspace_id: string;
  team_id: string;
  bot_id: string;
  person_id: string;
  channel_id: string;
  visibility: string;
  shared_to: string | null;
  shared_root_id: string | null;
  shared_by: string | null;
  shared_at: Date | null;
  created_at: Date;
};
export const CONVERSATION_COLUMNS =
  'thread_root_id, workspace_id, team_id, bot_id, person_id, channel_id, visibility, shared_to, shared_root_id, shared_by, shared_at, created_at';
export const toConversation = (r: ConversationRow): Conversation =>
  Conversation.parse({
    threadRootId: r.thread_root_id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    botId: r.bot_id,
    personId: r.person_id,
    channelId: r.channel_id,
    visibility: r.visibility,
    sharedTo: r.shared_to,
    sharedRootId: r.shared_root_id,
    sharedBy: r.shared_by,
    sharedAt: isoOrNull(r.shared_at),
    createdAt: iso(r.created_at),
  });

/** One row of the shared list query (routes.ts). `act_us` is the newest activity in microseconds since the epoch: the keyset of every list. */
export type ListRow = {
  thread_id: string;
  channel_id: string;
  source: 'conversation' | 'mention';
  channel_name: string | null;
  person_id: string;
  visibility: 'private' | 'shared' | null;
  shared_to: string | null;
  shared_name: string | null;
  shared_root: string | null;
  title: string | null;
  created_at: Date;
  reply_count: number | null;
  last_reply_at: Date | null;
  lm_id: string | null;
  lm_author: string | null;
  lm_preview: string | null;
  unread: number;
  act_us: string;
};

/** The kind of a message's author as the caller may learn it (`app.message_authors`): null for anybody that function does not name. */
export type AuthorKinds = ReadonlyMap<string, 'person' | 'bot' | 'system'>;

export function toListItem(r: ListRow, myPersonId: string, kinds: AuthorKinds): ConversationListItem {
  const kind = r.lm_author === null ? undefined : kinds.get(r.lm_author);
  return ConversationListItem.parse({
    threadRootId: r.thread_id,
    channelId: r.channel_id,
    source: r.source,
    channelName: r.channel_name,
    personId: r.person_id,
    mine: r.person_id === myPersonId,
    visibility: r.visibility,
    title: r.title ?? '',
    preview: r.lm_preview ?? '',
    lastAuthor: kind === 'person' || kind === 'bot' ? kind : null,
    lastActivityAt: iso(r.last_reply_at ?? r.created_at),
    replyCount: r.reply_count ?? 0,
    unreadCount: r.unread,
    sharedTo: r.shared_to === null ? null : { channelId: r.shared_to, name: r.shared_name, rootId: r.shared_root },
  });
}
