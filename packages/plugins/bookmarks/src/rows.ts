import { SAVED_BOOKMARK_SNIPPET_MAX, SavedBookmark, type BookmarkTarget, type BookmarkTargetKind, type SavedBookmarkItem } from '@manythreads/shared';

// The one place a `bookmarks` row, joined with what it points at, becomes the shared `SavedBookmark`.

/** `bookmarks` with the message (a thread's first message, or the bookmarked one), its channel and its thread, as the caller's own row-level security lets them see them. */
export interface BookmarkRow extends Record<string, unknown> {
  id: string;
  kind: BookmarkTargetKind;
  message_id: string | null;
  thread_root_id: string | null;
  file_id: string | null;
  team_id: string | null;
  path: string | null;
  created_at: Date;
  /** The message was found under the caller's policies (and so was its channel). */
  found: boolean;
  deleted: boolean;
  author_id: string | null;
  body_plain: string | null;
  message_created_at: Date | null;
  message_root_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  channel_kind: string | null;
  channel_team_id: string | null;
  thread_title: string | null;
  reply_count: number | null;
  last_reply_at: Date | null;
}

/** `FROM app.bookmarks b LEFT JOIN app.messages m ... LEFT JOIN app.channels c ... LEFT JOIN app.threads t ...`: every column `toSavedBookmark` reads. */
export const BOOKMARK_FROM = `FROM app.bookmarks b
  LEFT JOIN app.messages m ON m.id = coalesce(b.message_id, b.thread_root_id) AND b.kind IN ('thread', 'message')
  LEFT JOIN app.channels c ON c.id = m.channel_id
  LEFT JOIN app.threads t ON b.kind = 'thread' AND t.root_message_id = b.thread_root_id`;

export const BOOKMARK_COLUMNS = `b.id, b.kind, b.message_id, b.thread_root_id, b.file_id, b.team_id, b.path, b.created_at,
  (m.id IS NOT NULL AND c.id IS NOT NULL) AS found, (m.deleted_at IS NOT NULL) AS deleted,
  m.author_id, left(m.body_plain, 600) AS body_plain, m.created_at AS message_created_at, m.thread_root_id AS message_root_id,
  c.id AS channel_id, c.name AS channel_name, c.kind AS channel_kind, c.team_id AS channel_team_id,
  t.title AS thread_title, t.reply_count, t.last_reply_at`;

/** One line of at most 200 characters from a message's plain text. */
export function snippetOf(plain: string): string {
  const line = plain.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > SAVED_BOOKMARK_SNIPPET_MAX ? `${chars.slice(0, SAVED_BOOKMARK_SNIPPET_MAX - 1).join('')}…` : line;
}

/** The target a row points at, from its own columns only (never from the joined item, which the caller may not see). */
export function targetOf(r: Pick<BookmarkRow, 'kind' | 'message_id' | 'thread_root_id' | 'file_id' | 'team_id' | 'path'>): BookmarkTarget {
  switch (r.kind) {
    case 'thread':
      return { kind: 'thread', rootMessageId: r.thread_root_id! } as BookmarkTarget;
    case 'message':
      return { kind: 'message', messageId: r.message_id! } as BookmarkTarget;
    case 'file':
      return { kind: 'file', fileId: r.file_id! } as BookmarkTarget;
    case 'repo_file':
      return { kind: 'repo_file', teamId: r.team_id!, path: r.path! } as BookmarkTarget;
  }
}

/**
 * `authors` maps an author's actor id to a name (the channels plugin's `app.message_authors`, which names only authors of messages the caller can read).
 * What the caller cannot read becomes `item: null`: none of its text, author or channel is carried. A thread whose first message was deleted stays
 * readable while it has replies (the channel still shows it), with an empty snippet. Files are not shown yet (a later step): their item is null.
 */
export function toSavedBookmark(r: BookmarkRow, authors: ReadonlyMap<string, string>): SavedBookmark {
  let item: SavedBookmarkItem | null = null;
  if (r.found && r.channel_id && r.channel_kind && r.author_id && r.message_created_at) {
    const channel = { id: r.channel_id, name: r.channel_name ?? '', kind: r.channel_kind, teamId: r.channel_team_id };
    const replies = r.reply_count ?? 0;
    if (r.kind === 'thread' && (!r.deleted || replies > 0)) {
      item = {
        kind: 'thread',
        channel,
        title: r.deleted ? '' : (r.thread_title ?? ''),
        rootAuthorName: r.deleted ? '' : (authors.get(r.author_id) ?? 'Someone'),
        snippet: r.deleted ? '' : snippetOf(r.body_plain ?? ''),
        replyCount: replies,
        lastReplyAt: r.last_reply_at ? r.last_reply_at.toISOString() : null,
      } as SavedBookmarkItem;
    } else if (r.kind === 'message' && !r.deleted) {
      item = {
        kind: 'message',
        channel,
        threadRootId: r.message_root_id,
        authorId: r.author_id,
        authorName: authors.get(r.author_id) ?? 'Someone',
        snippet: snippetOf(r.body_plain ?? ''),
        messageCreatedAt: r.message_created_at.toISOString(),
      } as SavedBookmarkItem;
    }
  }
  return SavedBookmark.parse({ id: r.id, target: targetOf(r), createdAt: r.created_at.toISOString(), item });
}
