import { z } from 'zod';
import { MemoryRetainLogEntry, MemoryRetainOutcome, MemorySourceKind } from '../../entities/memory.ts';
import { TeamSlug } from '../teams/common.ts';

// What the platform retained into a team's memory, and what it withheld (PLAN P5-13; SPEC §12.1, §15 "what was withheld"). Read by the team's
// leads and by workspace admins; everyone else gets 403. The log never holds the retained text.

export const ListMemoryRetainLogPathParams = z.object({ slug: TeamSlug });
export type ListMemoryRetainLogPathParams = z.infer<typeof ListMemoryRetainLogPathParams>;

/** Newest first. `before` is the `next` of the previous page (an entry id). */
export const ListMemoryRetainLogQuery = z.strictObject({
  outcome: MemoryRetainOutcome.optional(),
  source: MemorySourceKind.optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListMemoryRetainLogQuery = z.infer<typeof ListMemoryRetainLogQuery>;

export const ListMemoryRetainLogResponse = z.object({
  items: z.array(MemoryRetainLogEntry),
  /** Pass as `before` for the next page; null on the last one. */
  next: z.uuid().nullable(),
});
export type ListMemoryRetainLogResponse = z.infer<typeof ListMemoryRetainLogResponse>;
export const listMemoryRetainLogRoute = { method: 'GET', path: '/api/teams/:slug/memory/retain-log' } as const;
