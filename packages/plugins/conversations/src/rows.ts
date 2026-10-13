import { ConversationListItem } from '@manythreads/shared';

// The plugin's mapper for the rows its lists read (PLAN B: one mapper per table). A list row is the thread's own facts joined to what the
// caller may read of it; nothing here is a copy stored on `conversations`.

const iso = (d: Date): string => d.toISOString();

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
