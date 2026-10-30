import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ProposalId, TeamId, WorkspaceId } from '../ids.ts';

/** A change to bots/, TEAM.md, skills/ or routines/ was proposed (PLAN P7-01). Names the file and the author, never the text. */
export const ProposalsProposalCreatedEvent = z.object({
  type: z.literal('proposals.proposal.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  proposalId: ProposalId,
  path: z.string(),
  op: z.enum(['put', 'delete']),
  authorId: ActorId,
  authorKind: z.enum(['person', 'bot']),
  /** Whether every check passed when it was made. */
  checksOk: z.boolean(),
  at: IsoDateTime,
});
export type ProposalsProposalCreatedEvent = z.infer<typeof ProposalsProposalCreatedEvent>;
