import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ProposalId, TeamId } from '../ids.ts';

// A proposal (PLAN P7-01, SPEC 7.2 and principle 5): a change to a bot's definition (`bots/`), `TEAM.md`, `skills/` or `routines/` is a proposal
// first. One proposal holds one file's new text (or its removal), the diff, the blob it was based on, who wrote it and the results of the checks
// run on it. A team lead or a workspace admin applies it, and the commit is theirs. A bot can only ever propose.

export const ProposalStatus = z.enum(['open', 'applied', 'rejected', 'withdrawn']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;
export const PROPOSAL_STATUSES = ProposalStatus.options;

/** `put` writes the whole file (new or changed); `delete` removes it. */
export const ProposalOp = z.enum(['put', 'delete']);
export type ProposalOp = z.infer<typeof ProposalOp>;

export const ProposalAuthorKind = z.enum(['person', 'bot']);
export type ProposalAuthorKind = z.infer<typeof ProposalAuthorKind>;

export const ProposalTitle = z.string().trim().min(1).max(200);
export const ProposalNote = z.string().trim().max(4000);

/** One check run on a proposal: what was checked, whether it passed, and the words to show. The BOT.md check carries the loader's own error text. */
export const ProposalCheck = z.object({
  name: z.string().min(1).max(60),
  ok: z.boolean(),
  message: z.string().max(1200),
});
export type ProposalCheck = z.infer<typeof ProposalCheck>;

export const Proposal = z.object({
  id: ProposalId,
  teamId: TeamId,
  /** The one file this proposal changes, as a path in the team repo. */
  path: z.string(),
  op: ProposalOp,
  title: z.string(),
  note: z.string(),
  status: ProposalStatus,
  authorId: ActorId,
  authorKind: ProposalAuthorKind,
  authorName: z.string(),
  /** The blob the proposal was made against (null: the file did not exist) and the repo head at that moment. */
  baseBlobSha: z.string().nullable(),
  baseCommitSha: z.string(),
  /** A unified diff of the change. */
  diff: z.string(),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  checks: z.array(ProposalCheck),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
  decidedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  /** The commit an applied proposal made (the head when the text was already there). */
  appliedCommitSha: z.string().nullable(),
  /** True when the author applied it themselves ("Propose and apply"). */
  selfApplied: z.boolean(),
});
export type Proposal = z.infer<typeof Proposal>;
