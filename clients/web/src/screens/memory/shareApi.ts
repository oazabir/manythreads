import {
  CreateProposalRequest,
  GetShareRunResponse,
  IncomingActionResponse,
  ListIncomingSharesResponse,
  ListSharesResponse,
  MemorySharingSetting,
  PreviewShareResponse,
  ProposalResponse,
  RunShareResponse,
  SetMemorySharingBody,
  actOnIncomingShareRoute,
  createProposalRoute,
  getMemorySharingRoute,
  getShareRunRoute,
  listIncomingSharesRoute,
  listSharesRoute,
  previewShareRoute,
  runShareRoute,
  setMemorySharingRoute,
  type ShareLinkAction,
} from '@manythreads/shared';
import { call } from '../../api/client';
import { decideApproval } from '../approvals/api';
import { definitionYaml, draftToDefinition, proposalTitle, shareFile, slugOfName, type ShareDraft } from './shareWords';

/*
 * What the Sharing tab and the workspace "Memory sharing" switch ask of the server (docs/plugins/memory-share.md). A share is a file in the team's repository,
 * `routines/shares/<slug>.yaml`, so a New share is a proposal for that file, applied at once by a lead or admin. A team that is asked to receive a share answers in
 * its Approvals row (accept or deny); pausing, resuming and ending an open link have their own route.
 */

export const fetchShares = (slug: string) => call(listSharesRoute, { response: ListSharesResponse }, undefined, { slug });

/** What the share would send now: nothing is built or stored. Leads and admins only. */
export const previewShare = (slug: string, shareSlug: string) => call(previewShareRoute, { response: PreviewShareResponse }, undefined, { slug, shareSlug });

/** Run now: starts a digest. The answer is the run in `building`; the page asks the list again to see where it ends. */
export const runShare = (slug: string, shareSlug: string) => call(runShareRoute, { response: RunShareResponse }, undefined, { slug, shareSlug });

/** One run, for the sentence the server wrote about how it ended. */
export const fetchShareRun = (slug: string, shareSlug: string, runId: string) => call(getShareRunRoute, { response: GetShareRunResponse }, undefined, { slug, shareSlug, runId });

export const fetchIncomingShares = (slug: string) => call(listIncomingSharesRoute, { response: ListIncomingSharesResponse }, undefined, { slug });

/** Pause, resume or end an open link (the receiving team's call). */
export const actOnIncoming = (slug: string, linkId: string, action: ShareLinkAction) =>
  call(actOnIncomingShareRoute, { response: IncomingActionResponse }, undefined, { slug, linkId, action });

/** Accept or decline a request: the request is an Approvals row of this team, and deciding it moves the link. */
export const decideRequest = (slug: string, approvalId: string, decision: 'approve' | 'deny') => decideApproval(slug, approvalId, decision, '');

export const fetchMemorySharing = () => call(getMemorySharingRoute, { response: MemorySharingSetting }, undefined, {});
export const setMemorySharing = (enabled: boolean) =>
  call(setMemorySharingRoute, { request: SetMemorySharingBody, response: MemorySharingSetting }, SetMemorySharingBody.parse({ enabled }), {});

/** New share: files the share's file as a proposal and applies it in the same step. The server loads the file a moment later and asks each named team to accept. */
export async function createShare(slug: string, draft: ShareDraft) {
  const file = slugOfName(draft.name);
  const text = definitionYaml(draftToDefinition(draft));
  return call(
    createProposalRoute,
    { request: CreateProposalRequest, response: ProposalResponse },
    CreateProposalRequest.parse({ path: shareFile(file), op: 'put', content: text, baseBlobSha: null, title: proposalTitle(draft.name), applyNow: true }),
    { slug },
  );
}
