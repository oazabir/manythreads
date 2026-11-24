import { z } from 'zod';
import { ChannelKind } from '../../entities/channel.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, BookmarkId, ChannelId, FileId, MessageId, TeamId } from '../../ids.ts';

// Bookmarks (P36-08, plugin `bookmarks`, docs/plans/bookmarks.md): a person keeps a thread, a message or a file to find it again. Bookmarks are the
// person's own: nobody else sees them, an admin included, and a bot has none (403). A bookmark holds ids and a path only, never any text: the list
// reads the item under the caller's own access every time, so a deleted message or a channel the person left shows "No longer available" and
// nothing of the item. (The channel header's shared links are a different thing: `ChannelBookmark` in ../channels/bookmarks.ts.)

/** The most bookmarks one person keeps. */
export const SAVED_BOOKMARKS_MAX = 500;
/** What a full list says (the database's cap trigger raises the same sentence). */
export const SAVED_BOOKMARKS_FULL = 'You have 500 bookmarks. Remove some first.';
/** The longest path of a bookmarked file of a team's repository. */
export const SAVED_BOOKMARK_PATH_MAX = 1024;
/** The snippet of a bookmarked message or thread: plain text, one line, at most this many characters. */
export const SAVED_BOOKMARK_SNIPPET_MAX = 200;
/** The most bookmarks one page of the list holds. */
export const SAVED_BOOKMARKS_PAGE_MAX = 50;

/** What a bookmark points at. `repo_file` is a file of a team's repository, kept by its path; `file` is an attachment or a Personal file, kept by its id. */
export const BookmarkTargetKind = z.enum(['thread', 'message', 'file', 'repo_file']);
export type BookmarkTargetKind = z.infer<typeof BookmarkTargetKind>;

const RepoPath = z
  .string()
  .min(1)
  .max(SAVED_BOOKMARK_PATH_MAX)
  .refine((p) => !p.includes('\u0000'), 'a path has no NUL character');

export const BookmarkTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('thread'), rootMessageId: MessageId }),
  z.strictObject({ kind: z.literal('message'), messageId: MessageId }),
  z.strictObject({ kind: z.literal('file'), fileId: FileId }),
  z.strictObject({ kind: z.literal('repo_file'), teamId: TeamId, path: RepoPath }),
]);
export type BookmarkTarget = z.infer<typeof BookmarkTarget>;

/** The one string that names a target among the person's bookmarks of its kind: what `/keys` and the push carry, and what a filled icon looks up. */
export function bookmarkKey(target: BookmarkTarget): string {
  switch (target.kind) {
    case 'thread':
      return target.rootMessageId;
    case 'message':
      return target.messageId;
    case 'file':
      return target.fileId;
    case 'repo_file':
      return `${target.teamId}:${target.path}`;
  }
}

/** Where a bookmarked thread or message lives: enough to write "# dev" or "Direct message" and to open it. */
export const BookmarkPlace = z.object({
  id: ChannelId,
  name: z.string(),
  kind: ChannelKind,
  teamId: TeamId.nullable(),
  /** A conversation with a bot: the bot's name ("Conversation with Brain"), when the caller can read the bot; null otherwise. */
  botName: z.string().nullable(),
});
export type BookmarkPlace = z.infer<typeof BookmarkPlace>;

/** A bookmarked thread as the caller may read it now. */
export const SavedThreadItem = z.object({
  kind: z.literal('thread'),
  channel: BookmarkPlace,
  /** The thread's title (the first line of its first message); may be empty. */
  title: z.string(),
  rootAuthorName: z.string(),
  /** One line of the first message, at most 200 characters (empty when that message was deleted). */
  snippet: z.string().max(SAVED_BOOKMARK_SNIPPET_MAX),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
});
export type SavedThreadItem = z.infer<typeof SavedThreadItem>;

/** A bookmarked message as the caller may read it now. */
export const SavedMessageItem = z.object({
  kind: z.literal('message'),
  channel: BookmarkPlace,
  /** The first message of the thread when the bookmarked message is a reply; null otherwise. */
  threadRootId: MessageId.nullable(),
  authorId: ActorId,
  authorName: z.string(),
  snippet: z.string().max(SAVED_BOOKMARK_SNIPPET_MAX),
  messageCreatedAt: IsoDateTime,
});
export type SavedMessageItem = z.infer<typeof SavedMessageItem>;

/** Where a bookmarked file lives: an attachment of a channel (or of a team), a Personal file of the person, or a file of a team's repository. */
export const SavedFileStore = z.enum(['attachment', 'personal', 'repo']);
export type SavedFileStore = z.infer<typeof SavedFileStore>;

/** The team a bookmarked file belongs to, when it belongs to one the caller can read: enough to say "Engineering" and to open its Files. */
export const BookmarkTeam = z.object({ id: TeamId, slug: z.string(), name: z.string() });
export type BookmarkTeam = z.infer<typeof BookmarkTeam>;

/**
 * A bookmarked file as the caller may read it now. An attachment carries its channel (and its size); a Personal file its path in the person's space; a file
 * of a repository its team and path. A repository file kept by its path that is no longer there (renamed, moved or deleted) stays readable with
 * `missing: true` and no size: the team is still the caller's, and the viewer says the file is no longer there.
 */
export const SavedFileItem = z.object({
  kind: z.literal('file'),
  store: SavedFileStore,
  name: z.string(),
  /** A Personal file's or a repository file's path; null for an attachment (it opens by its id). */
  path: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  mime: z.string().nullable(),
  channel: BookmarkPlace.nullable(),
  team: BookmarkTeam.nullable(),
  missing: z.boolean(),
});
export type SavedFileItem = z.infer<typeof SavedFileItem>;

export const SavedBookmarkItem = z.discriminatedUnion('kind', [SavedThreadItem, SavedMessageItem, SavedFileItem]);
export type SavedBookmarkItem = z.infer<typeof SavedBookmarkItem>;

/**
 * One bookmark. `item` is null when the caller can no longer read what it points at (it was deleted, or their access ended): the list then says
 * "No longer available" and carries nothing of it.
 */
export const SavedBookmark = z.object({
  id: BookmarkId,
  target: BookmarkTarget,
  createdAt: IsoDateTime,
  item: SavedBookmarkItem.nullable(),
});
export type SavedBookmark = z.infer<typeof SavedBookmark>;

/** The tabs of the Bookmarks page; `file` holds both file kinds. */
export const SavedBookmarkTab = z.enum(['thread', 'message', 'file']);
export type SavedBookmarkTab = z.infer<typeof SavedBookmarkTab>;

export const ListSavedBookmarksQuery = z.object({
  kind: SavedBookmarkTab.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(SAVED_BOOKMARKS_PAGE_MAX).default(SAVED_BOOKMARKS_PAGE_MAX),
});
export type ListSavedBookmarksQuery = z.infer<typeof ListSavedBookmarksQuery>;

export const SavedBookmarkCounts = z.object({
  thread: z.number().int().nonnegative(),
  message: z.number().int().nonnegative(),
  file: z.number().int().nonnegative(),
});
export type SavedBookmarkCounts = z.infer<typeof SavedBookmarkCounts>;

/** The caller's bookmarks, newest first, one page; `counts` covers every bookmark of each tab. */
export const ListSavedBookmarksResponse = z.object({
  items: z.array(SavedBookmark),
  nextCursor: BookmarkId.nullable(),
  counts: SavedBookmarkCounts,
});
export type ListSavedBookmarksResponse = z.infer<typeof ListSavedBookmarksResponse>;
export const listSavedBookmarksRoute = { method: 'GET', path: '/api/bookmarks' } as const;

export const SavedBookmarkKey = z.object({ id: BookmarkId, kind: BookmarkTargetKind, key: z.string() });
export type SavedBookmarkKey = z.infer<typeof SavedBookmarkKey>;

/** Every bookmark of the caller as a key (at most 500): what fills the icons and decides whether the sidebar shows Bookmarks. */
export const SavedBookmarkKeysResponse = z.object({ total: z.number().int().nonnegative(), items: z.array(SavedBookmarkKey) });
export type SavedBookmarkKeysResponse = z.infer<typeof SavedBookmarkKeysResponse>;
export const savedBookmarkKeysRoute = { method: 'GET', path: '/api/bookmarks/keys' } as const;

/**
 * Bookmark something. Idempotent: 201 with a new bookmark, 200 with the one already there. 403 when the caller cannot see it (an unknown id looks the
 * same; for a file, also one that was deleted), 404 when it is gone (a deleted message, a repository path with no file), 400 for a folder or a path that
 * is not a file's, 409 when the list is full.
 */
export const SaveBookmarkRequest = z.strictObject({ target: BookmarkTarget });
export type SaveBookmarkRequest = z.infer<typeof SaveBookmarkRequest>;
export const saveBookmarkRoute = { method: 'PUT', path: '/api/bookmarks' } as const;

export const SavedBookmarkPathParams = z.object({ bookmarkId: BookmarkId });
export const RemoveSavedBookmarkResponse = z.object({ removed: z.boolean() });
export type RemoveSavedBookmarkResponse = z.infer<typeof RemoveSavedBookmarkResponse>;
export const removeSavedBookmarkRoute = { method: 'DELETE', path: '/api/bookmarks/:bookmarkId' } as const;

/** A bookmark of the person was added (`on`) or removed, in any tab: sent to that person only, after the change is committed. */
export const WS_BOOKMARKS_CHANGED = 'bookmarks.changed';
export const BookmarksChangedPush = z.object({ id: BookmarkId, kind: BookmarkTargetKind, key: z.string(), on: z.boolean() });
export type BookmarksChangedPush = z.infer<typeof BookmarksChangedPush>;
