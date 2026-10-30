import { z } from 'zod';
import { ProposalId } from '../../ids.ts';
import { Proposal, ProposalNote, ProposalOp, ProposalStatus, ProposalTitle } from '../../entities/proposal.ts';

// The routes of proposals (PLAN P7-01); the entity itself is in entities/proposal.ts.

/** The most characters of file text one proposal may carry. */
export const PROPOSAL_MAX_CHARS = 256 * 1024;
/** The most proposals one author may have waiting at the same time in one team. */
export const PROPOSAL_MAX_OPEN_PER_AUTHOR = 50;

/** A proposal as the signed-in person sees it: whether the file moved since, and what they may do with it. */
export const ProposalDetail = z.object({
  proposal: Proposal,
  /** True while open and the file is no longer the one the proposal was made against: it cannot be applied. */
  stale: z.boolean(),
  staleReason: z.string().nullable(),
  /** Whether this person may apply it right now, and if not, why not in plain words. */
  canApply: z.boolean(),
  cannotApplyReason: z.string().nullable(),
  canReject: z.boolean(),
  canWithdraw: z.boolean(),
});
export type ProposalDetail = z.infer<typeof ProposalDetail>;

export const TeamProposalParams = z.object({ slug: z.string().min(1) });
export type TeamProposalParams = z.infer<typeof TeamProposalParams>;
export const ProposalParams = z.object({ slug: z.string().min(1), proposalId: ProposalId });
export type ProposalParams = z.infer<typeof ProposalParams>;

/**
 * Make a proposal. `baseBlobSha` is the blob the author edited (`null`: the file is new); left out, the proposal is based on the file as it is now
 * (what a bot does). `applyNow` records the proposal and applies it in one step; only a lead or a workspace admin may.
 */
export const CreateProposalRequest = z.strictObject({
  path: z.string().min(1).max(1024),
  op: ProposalOp.default('put'),
  content: z.string().max(PROPOSAL_MAX_CHARS).optional(),
  baseBlobSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable().optional(),
  title: ProposalTitle.optional(),
  note: ProposalNote.optional(),
  applyNow: z.boolean().optional(),
});
export type CreateProposalRequest = z.infer<typeof CreateProposalRequest>;
export const ProposalResponse = z.object({ proposal: ProposalDetail });
export type ProposalResponse = z.infer<typeof ProposalResponse>;
export const createProposalRoute = { method: 'POST', path: '/api/teams/:slug/proposals' } as const;

export const ListProposalsQuery = z.object({
  status: ProposalStatus.optional(),
  path: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListProposalsQuery = z.infer<typeof ListProposalsQuery>;
export const ListProposalsResponse = z.object({
  proposals: z.array(Proposal),
  /** How many proposals of this team wait for a decision (whatever the filter). */
  openCount: z.number().int().min(0),
});
export type ListProposalsResponse = z.infer<typeof ListProposalsResponse>;
export const listProposalsRoute = { method: 'GET', path: '/api/teams/:slug/proposals' } as const;

export const getProposalRoute = { method: 'GET', path: '/api/teams/:slug/proposals/:proposalId' } as const;

/** Apply: commits the change as the person who applies it. */
export const DecideProposalRequest = z.strictObject({ note: ProposalNote.optional() });
export type DecideProposalRequest = z.infer<typeof DecideProposalRequest>;
export const approveProposalRoute = { method: 'POST', path: '/api/teams/:slug/proposals/:proposalId/approve' } as const;
export const rejectProposalRoute = { method: 'POST', path: '/api/teams/:slug/proposals/:proposalId/reject' } as const;
export const withdrawProposalRoute = { method: 'POST', path: '/api/teams/:slug/proposals/:proposalId/withdraw' } as const;

/** The name of the check run on `bots/<slug>/BOT.md`. */
export const BOT_MD_CHECK = 'BOT.md loads';
