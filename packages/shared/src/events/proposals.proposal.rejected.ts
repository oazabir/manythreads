import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ProposalId, TeamId, WorkspaceId } from '../ids.ts';

/** A proposal was turned down by a lead or an admin, or taken back by its author (`reason`) (PLAN P7-01). */
export const ProposalsProposalRejectedEvent = z.object({
  type: z.literal('proposals.proposal.rejected'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  proposalId: ProposalId,
  path: z.string(),
  authorId: ActorId,
  actorId: ActorId,
  reason: z.enum(['rejected', 'withdrawn']),
  at: IsoDateTime,
});
export type ProposalsProposalRejectedEvent = z.infer<typeof ProposalsProposalRejectedEvent>;
