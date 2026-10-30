import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ProposalId, TeamId, WorkspaceId } from '../ids.ts';

/** A proposal was applied: the change was committed to the team repo as `actorId` (the person who applied it) (PLAN P7-01). */
export const ProposalsProposalAppliedEvent = z.object({
  type: z.literal('proposals.proposal.applied'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  proposalId: ProposalId,
  path: z.string(),
  op: z.enum(['put', 'delete']),
  /** Who made the proposal, and who applied it. */
  authorId: ActorId,
  actorId: ActorId,
  /** True when the author applied their own proposal ("Propose and apply"). */
  selfApplied: z.boolean(),
  commitSha: z.string(),
  at: IsoDateTime,
});
export type ProposalsProposalAppliedEvent = z.infer<typeof ProposalsProposalAppliedEvent>;
