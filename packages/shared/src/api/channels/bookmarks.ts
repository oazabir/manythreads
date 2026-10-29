import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId } from '../../ids.ts';

/** The most bookmarks one channel keeps (the bar is one row, not a list). */
export const MAX_CHANNEL_BOOKMARKS = 20;

export const BookmarkKind = z.enum(['link', 'file', 'page']);
export type BookmarkKind = z.infer<typeof BookmarkKind>;

/**
 * One entry of a channel's bookmarks bar. `target` is what the kind points at: a web address (`link`), a file's id (`file`) or a path under
 * `pages/` in the team's repository (`page`). The bookmark holds no content: opening a file or page is checked again when it is opened.
 */
export const ChannelBookmark = z.object({
  id: z.uuid(),
  channelId: ChannelId,
  kind: BookmarkKind,
  title: z.string().min(1).max(80),
  target: z.string().min(1).max(2000),
  createdAt: IsoDateTime,
});
export type ChannelBookmark = z.infer<typeof ChannelBookmark>;

export const BookmarkPathParams = z.object({ channelId: ChannelId });
export const BookmarkItemPathParams = z.object({ channelId: ChannelId, bookmarkId: z.uuid() });

export const ListBookmarksResponse = z.object({ items: z.array(ChannelBookmark) });
export type ListBookmarksResponse = z.infer<typeof ListBookmarksResponse>;
export const listBookmarksRoute = { method: 'GET', path: '/api/channels/:channelId/bookmarks' } as const;

/**
 * Add a bookmark. `title` may be left out: a link is named by its host, a file by its name, a page by its file name. A `link` is an
 * `http(s)` address; a `file` is the id of a file in this channel; a `page` is a Markdown path under `pages/` (team channels only).
 */
export const AddBookmarkRequest = z.strictObject({
  kind: BookmarkKind,
  target: z.string().trim().min(1).max(2000),
  title: z.string().trim().min(1).max(80).optional(),
});
export type AddBookmarkRequest = z.infer<typeof AddBookmarkRequest>;
export const AddBookmarkResponse = ChannelBookmark;
export type AddBookmarkResponse = z.infer<typeof AddBookmarkResponse>;
export const addBookmarkRoute = { method: 'POST', path: '/api/channels/:channelId/bookmarks' } as const;

export const RemoveBookmarkResponse = z.object({ removed: z.boolean() });
export type RemoveBookmarkResponse = z.infer<typeof RemoveBookmarkResponse>;
export const removeBookmarkRoute = { method: 'DELETE', path: '/api/channels/:channelId/bookmarks/:bookmarkId' } as const;

