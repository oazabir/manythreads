import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, FileId, MessageId, TeamId } from '../../ids.ts';

/** What to look in. `all` is messages, threads and files. */
export const SearchScope = z.enum(['messages', 'threads', 'files', 'all']);
export type SearchScope = z.infer<typeof SearchScope>;

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

/** Each list is empty when the scope leaves it out. "No results in what you can see." is the client's copy for three empty lists. */
export const SearchResponse = z.object({
  query: z.string(),
  messages: z.array(SearchMessageHit),
  threads: z.array(SearchThreadHit),
  files: z.array(SearchFileHit),
});
export type SearchResponse = z.infer<typeof SearchResponse>;
export const searchRoute = { method: 'GET', path: '/api/search' } as const;
