import {
  CreateProposalRequest,
  DecideProposalRequest,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  ListProposalsQuery,
  ListProposalsResponse,
  ProposalResponse,
  approveProposalRoute,
  createProposalRoute,
  getProposalRoute,
  getRepoBlobRoute,
  listProposalsRoute,
  rejectProposalRoute,
  withdrawProposalRoute,
  type ProposalStatus,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Proposals screens ask of the server (PLAN P7-01). A proposal is one change to one file in bots/, TEAM.md, skills/ or routines/; a team
 * lead or a workspace admin applies it. The server words every refusal in plain text (a moved file, a BOT.md that does not load), so the screens show
 * `err.message` as it comes.
 */

export const fetchProposals = (slug: string, status?: ProposalStatus) =>
  call(listProposalsRoute, { request: ListProposalsQuery, response: ListProposalsResponse }, ListProposalsQuery.parse(status ? { status } : {}), { slug });

export const fetchProposal = (slug: string, proposalId: string) => call(getProposalRoute, { response: ProposalResponse }, undefined, { slug, proposalId });

export type NewProposal = { path: string; op: 'put' | 'delete'; content?: string; baseBlobSha?: string | null; title: string; note?: string; applyNow?: boolean };

export const createProposal = (slug: string, body: NewProposal) =>
  call(createProposalRoute, { request: CreateProposalRequest, response: ProposalResponse }, CreateProposalRequest.parse(body), { slug });

const decide = (route: typeof approveProposalRoute | typeof rejectProposalRoute | typeof withdrawProposalRoute) => (slug: string, proposalId: string, note?: string) =>
  call(route, { request: DecideProposalRequest, response: ProposalResponse }, DecideProposalRequest.parse(note ? { note } : {}), { slug, proposalId });
export const approveProposal = decide(approveProposalRoute);
export const rejectProposal = decide(rejectProposalRoute);
export const withdrawProposal = decide(withdrawProposalRoute);

/** The file as it is now: its text and the blob a proposal is based on. `null` when the file does not exist (a new file). */
export async function readCurrent(slug: string, path: string): Promise<{ content: string; blobSha: string } | null> {
  try {
    const b = await call(getRepoBlobRoute, { request: GetRepoBlobQuery, response: GetRepoBlobResponse }, GetRepoBlobQuery.parse({ path }), { slug });
    const content = b.encoding === 'utf8' ? b.content : new TextDecoder().decode(Uint8Array.from(atob(b.content), (c) => c.charCodeAt(0)));
    return { content, blobSha: b.blobSha };
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { status?: number }).status === 404) return null;
    throw err;
  }
}
