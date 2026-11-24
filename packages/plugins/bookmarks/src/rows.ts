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
  /** The bot of a conversation with a bot, as the caller's own policies on bots show it. */
  bot_name: string | null;
  thread_title: string | null;
  reply_count: number | null;
  last_reply_at: Date | null;
  /** A `file` bookmark: the file as the caller's file policies show it (null when they do not, or it was deleted), and its channel. */
  file_found_id: string | null;
  file_name: string | null;
  file_size: string | number | null;
  file_mime: string | null;
  file_folder: string | null;
  file_personal: boolean | null;
  file_channel_id: string | null;
  file_channel_name: string | null;
  file_channel_kind: string | null;
  file_channel_team_id: string | null;
  /** The team of a `repo_file` bookmark (or of a team's file), only when the caller can read that team. */
  team_found_id: string | null;
  team_slug: string | null;
  team_name: string | null;
  /** A `repo_file` bookmark: whether the path is in the team's repository now, and its size. */
  repo_exists: boolean | null;
  repo_size: string | number | null;
}

/**
 * `FROM app.bookmarks b LEFT JOIN ...`: every column `toSavedBookmark` reads, each under the caller’s own row-level security (a conversation’s bot under the bots plugin’s policy). A file is shown only when it is
 * not someone else's Personal file (an admin's audited look into a space shows them, a bookmark never does); a team only when the caller reads it (the
 * index of a repository, `repo_entries`, of the repo-git plugin, is readable by the same people).
 */
export const BOOKMARK_FROM = `FROM app.bookmarks b
  LEFT JOIN app.messages m ON m.id = coalesce(b.message_id, b.thread_root_id) AND b.kind IN ('thread', 'message')
  LEFT JOIN app.channels c ON c.id = m.channel_id
  LEFT JOIN app.bots bt ON c.kind = 'bot_conversation' AND bt.id = c.bot_id
  LEFT JOIN app.threads t ON b.kind = 'thread' AND t.root_message_id = b.thread_root_id
  LEFT JOIN app.files f ON b.kind = 'file' AND f.id = b.file_id AND (f.owner_person_id IS NULL OR f.owner_person_id = (SELECT app.person_id()))
  LEFT JOIN app.channels fc ON fc.id = f.channel_id
  LEFT JOIN app.teams tm ON tm.id = coalesce(b.team_id, CASE WHEN f.channel_id IS NULL THEN f.team_id END)
    AND tm.id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
  LEFT JOIN app.repo_entries e ON b.kind = 'repo_file' AND e.team_id = tm.id AND e.path = b.path`;

export const BOOKMARK_COLUMNS = `b.id, b.kind, b.message_id, b.thread_root_id, b.file_id, b.team_id, b.path, b.created_at,
  (m.id IS NOT NULL AND c.id IS NOT NULL) AS found, (m.deleted_at IS NOT NULL) AS deleted,
  m.author_id, left(m.body_plain, 600) AS body_plain, m.created_at AS message_created_at, m.thread_root_id AS message_root_id,
  c.id AS channel_id, c.name AS channel_name, c.kind AS channel_kind, c.team_id AS channel_team_id, bt.name AS bot_name,
  t.title AS thread_title, t.reply_count, t.last_reply_at,
  f.id AS file_found_id, f.name AS file_name, f.size AS file_size, f.mime AS file_mime, f.folder_path AS file_folder, (f.owner_person_id IS NOT NULL) AS file_personal,
  fc.id AS file_channel_id, fc.name AS file_channel_name, fc.kind AS file_channel_kind, fc.team_id AS file_channel_team_id,
  tm.id AS team_found_id, tm.slug AS team_slug, tm.name AS team_name,
  (e.path IS NOT NULL) AS repo_exists, e.size AS repo_size`;

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
 * readable while it has replies (the channel still shows it), with an empty snippet. A file is readable while the caller's file policies show it; a
 * repository file while the caller reads its team (a path no longer in the repository says `missing`, since the team's tree is the caller's to read anyway).
 */
export function toSavedBookmark(r: BookmarkRow, authors: ReadonlyMap<string, string>): SavedBookmark {
  let item: SavedBookmarkItem | null = null;
  if (r.kind === 'file' || r.kind === 'repo_file') item = fileItemOf(r);
  else if (r.found && r.channel_id && r.channel_kind && r.author_id && r.message_created_at) {
    const channel = { id: r.channel_id, name: r.channel_name ?? '', kind: r.channel_kind, teamId: r.channel_team_id, botName: r.channel_kind === 'bot_conversation' ? r.bot_name : null };
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

const sizeOf = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The last part of a path: what a repository file is called. */
export const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A file bookmark's item, or null when the caller cannot read the file (or the team of a repository file) now. */
function fileItemOf(r: BookmarkRow): SavedBookmarkItem | null {
  const team = r.team_found_id && r.team_slug && r.team_name ? { id: r.team_found_id, slug: r.team_slug, name: r.team_name } : null;
  if (r.kind === 'repo_file') {
    if (!team || !r.path) return null;
    const exists = r.repo_exists === true;
    return { kind: 'file', store: 'repo', name: baseNameOf(r.path), path: r.path, size: exists ? sizeOf(r.repo_size) : null, mime: null, channel: null, team, missing: !exists } as SavedBookmarkItem;
  }
  if (!r.file_found_id || !r.file_name) return null;
  const personal = r.file_personal === true;
  const channel =
    r.file_channel_id && r.file_channel_kind
      ? { id: r.file_channel_id, name: r.file_channel_name ?? '', kind: r.file_channel_kind, teamId: r.file_channel_team_id, botName: null }
      : null;
  // a folder in the database ends with a slash (`Notes/`); a path on the wire does not
  const path = personal && r.file_folder ? `${r.file_folder.replace(/\/$/, '')}/${r.file_name}` : null;
  return {
    kind: 'file',
    store: personal ? 'personal' : 'attachment',
    name: r.file_name,
    path,
    size: sizeOf(r.file_size),
    mime: r.file_mime,
    channel,
    team: personal ? null : team,
    missing: false,
  } as SavedBookmarkItem;
}
