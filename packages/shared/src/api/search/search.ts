import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, FileId, MessageId, TeamId } from '../../ids.ts';
import { SearchFilters } from './syntax.ts';

/** What to look in. `all` is messages, threads, files and pages. */
export const SearchScope = z.enum(['messages', 'threads', 'files', 'pages', 'all']);
export type SearchScope = z.infer<typeof SearchScope>;

/**
 * `q` is the whole box: the text to look for and, among it, the filter words (`from:` `in:` `has:` `is:` `before:` `after:`, see
 * `parseSearchText`). A box holding only filter words is a search too (every message from one person, say), newest first.
 */
export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  scope: SearchScope.default('all'),
  /** Only channels of this team. Never widens what the caller can see. */
  teamId: TeamId.optional(),
  /** Per kind. */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** The channel a hit sits in; `name` is null for a DM or bot conversation (the client labels it). */
const HitChannel = z.object({ id: ChannelId, name: z.string().nullable(), kind: z.enum(['channel', 'dm', 'bot_conversation']), teamId: TeamId.nullable() });

/** `score` is the trigram word similarity (0 to 1); hits come best first, ties newest first. */
export const SearchMessageHit = z.object({
  id: MessageId,
  channel: HitChannel,
  authorId: ActorId,
  threadRootId: MessageId.nullable(),
  /** The start of the message's plain text (at most 240 characters). */
  snippet: z.string(),
  score: z.number(),
  createdAt: IsoDateTime,
});
export type SearchMessageHit = z.infer<typeof SearchMessageHit>;

export const SearchThreadHit = z.object({
  rootMessageId: MessageId,
  channel: HitChannel,
  title: z.string(),
  replyCount: z.number().int().nonnegative(),
  score: z.number(),
  lastReplyAt: IsoDateTime,
});
export type SearchThreadHit = z.infer<typeof SearchThreadHit>;

export const SearchFileHit = z.object({
  id: FileId,
  channel: HitChannel.nullable(),
  folderPath: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  score: z.number(),
  createdAt: IsoDateTime,
});
export type SearchFileHit = z.infer<typeof SearchFileHit>;

/** A page of a team: a Markdown file under `pages/` of the team's repository. `snippet` is the start of its text. */
export const SearchPageHit = z.object({
  teamId: TeamId,
  path: z.string(),
  name: z.string(),
  snippet: z.string(),
  score: z.number(),
  updatedAt: IsoDateTime,
});
export type SearchPageHit = z.infer<typeof SearchPageHit>;

/** Which lists had more to show than `limit`. It says only that the person's own readable hits go on, never how many others exist. */
export const SearchMore = z.object({ messages: z.boolean(), threads: z.boolean(), files: z.boolean(), pages: z.boolean() });
export type SearchMore = z.infer<typeof SearchMore>;

/**
 * Each list is empty when the scope or the filters leave it out. "No results in what you can see." is the client's copy for empty lists.
 * Every list is built from rows the caller may read; no number in this answer counts anything the caller cannot see.
 * `query` is the text to look for, `filters` what was read from the box, `unmatched` the names after `from:` or `in:` that match nobody
 * (or no channel) the caller can see, as typed; such a filter finds nothing.
 */
export const SearchResponse = z.object({
  query: z.string(),
  filters: SearchFilters,
  unmatched: z.array(z.string()),
  messages: z.array(SearchMessageHit),
  threads: z.array(SearchThreadHit),
  files: z.array(SearchFileHit),
  pages: z.array(SearchPageHit),
  more: SearchMore,
});
export type SearchResponse = z.infer<typeof SearchResponse>;
export const searchRoute = { method: 'GET', path: '/api/search' } as const;

/** The most searches one person keeps. */
export const MAX_SAVED_SEARCHES = 50;

/** A search a person keeps under a name: the box's text, run again as the reader each time (it stores no result). */
export const SavedSearch = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  query: z.string().min(2).max(200),
  createdAt: IsoDateTime,
});
export type SavedSearch = z.infer<typeof SavedSearch>;

export const ListSavedSearchesResponse = z.object({ items: z.array(SavedSearch) });
export type ListSavedSearchesResponse = z.infer<typeof ListSavedSearchesResponse>;
export const listSavedSearchesRoute = { method: 'GET', path: '/api/search/saved' } as const;

export const SaveSearchRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  query: z.string().trim().min(2).max(200),
});
export type SaveSearchRequest = z.infer<typeof SaveSearchRequest>;
export const SaveSearchResponse = SavedSearch;
export type SaveSearchResponse = z.infer<typeof SaveSearchResponse>;
export const saveSearchRoute = { method: 'POST', path: '/api/search/saved' } as const;

export const SavedSearchPathParams = z.object({ savedSearchId: z.uuid() });
export const DeleteSavedSearchResponse = z.object({ removed: z.boolean() });
export type DeleteSavedSearchResponse = z.infer<typeof DeleteSavedSearchResponse>;
export const deleteSavedSearchRoute = { method: 'DELETE', path: '/api/search/saved/:savedSearchId' } as const;
