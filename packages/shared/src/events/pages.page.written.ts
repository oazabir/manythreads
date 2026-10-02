import { z } from 'zod';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A page (a text file under `pages/` of a team repo) was written through `pages.write`: created, replaced or appended to, by a person or a bot. One event
 * per write that changed the page, in the transaction of its commit, next to `repo.repo.committed` (which carries the same commit as a path list). Carries
 * ids, the path and sizes, never the content. `actorKind` says whether a person or a bot wrote it.
 */
export const PagesPageWrittenEvent = z.object({
  type: z.literal('pages.page.written'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  path: z.string().min(1),
  mode: z.enum(['create', 'replace', 'append']),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  blobSha: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().nonnegative(),
  authorId: ActorId,
  actorKind: z.enum(['person', 'bot']),
});
export type PagesPageWrittenEvent = z.infer<typeof PagesPageWrittenEvent>;
