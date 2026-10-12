import {
  DecideApprovalRequest,
  DecideApprovalResponse,
  GetApprovalsSummaryResponse,
  ListApprovalsQuery,
  ListApprovalsResponse,
  ListThreadApprovalsResponse,
  approveApprovalRoute,
  denyApprovalRoute,
  getApprovalsSummaryRoute,
  listApprovalsRoute,
  listThreadApprovalsRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Approvals screens ask of the server (PLAN P5-20): the team's inbox, the sidebar count, one decision, and the approvals raised in a
 * thread (the card under its replies). Deciding is refused for the person who asked (403) and anyone outside the approver scope.
 */

export const fetchApprovals = (slug: string, status: 'pending' | 'decided') =>
  call(listApprovalsRoute, { request: ListApprovalsQuery, response: ListApprovalsResponse }, ListApprovalsQuery.parse({ status }), { slug });

export const fetchApprovalsSummary = (slug: string) => call(getApprovalsSummaryRoute, { response: GetApprovalsSummaryResponse }, undefined, { slug });

export const decideApproval = (slug: string, approvalId: string, decision: 'approve' | 'deny', note: string) =>
  call(
    decision === 'approve' ? approveApprovalRoute : denyApprovalRoute,
    { request: DecideApprovalRequest, response: DecideApprovalResponse },
    DecideApprovalRequest.parse({ note }),
    { slug, approvalId },
  );

export const fetchThreadApprovals = (rootId: string) => call(listThreadApprovalsRoute, { response: ListThreadApprovalsResponse }, undefined, { rootId });
