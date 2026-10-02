import { z } from 'zod';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A commit landed in a team's repo through the writer (one event per commit, in the transaction that updated the index). Carries ids, the
 * subject line and the changed paths, never file content. `authorId` is null for a commit the system made (a team's first commit).
 */
export const RepoRepoCommittedEvent = z.object({
  type: z.literal('repo.repo.committed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  parentSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  authorId: ActorId.nullable(),
  coAuthorIds: z.array(ActorId),
  subject: z.string(),
  paths: z.array(z.object({ path: z.string().min(1), op: z.enum(['put', 'delete']) })),
});
export type RepoRepoCommittedEvent = z.infer<typeof RepoRepoCommittedEvent>;
