import { z } from 'zod';
import { Approval } from '../../entities/approval.ts';
import { JsonObject } from '../../entities/kernel.ts';
import { ApprovalId, MessageId, TeamId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// The Approvals inbox (SPEC §7.3, PLAN P5-20). One mechanism, many sources: everything a bot's call waits on is a row here. A person who
// can see the team reads them; deciding needs the approver scope of the row and is never allowed to the person who asked.

export const ApprovalListStatus = z.enum(['pending', 'decided']);
export type ApprovalListStatus = z.infer<typeof ApprovalListStatus>;

export const ListApprovalsPathParams = z.object({ slug: TeamSlug });
export type ListApprovalsPathParams = z.infer<typeof ListApprovalsPathParams>;

/** `pending` (default): what waits, oldest first. `decided`: what was settled, newest first. */
export const ListApprovalsQuery = z.strictObject({
  status: ApprovalListStatus.default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuery>;

export const ListApprovalsResponse = z.object({
  items: z.array(Approval),
  /** How many are pending in this team, whatever the list shows (the sidebar count). */
  waiting: z.number().int().nonnegative(),
});
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponse>;
export const listApprovalsRoute = { method: 'GET', path: '/api/teams/:slug/approvals' } as const;

/** The sidebar badge: how many approvals wait in the team, and how many of those the caller may decide. */
export const GetApprovalsSummaryResponse = z.object({
  waiting: z.number().int().nonnegative(),
  mine: z.number().int().nonnegative(),
});
export type GetApprovalsSummaryResponse = z.infer<typeof GetApprovalsSummaryResponse>;
export const getApprovalsSummaryRoute = { method: 'GET', path: '/api/teams/:slug/approvals/summary' } as const;

export const DecideApprovalPathParams = z.object({ slug: TeamSlug, approvalId: ApprovalId });
export type DecideApprovalPathParams = z.infer<typeof DecideApprovalPathParams>;

/** An optional reason, shown on the settled row. */
export const DecideApprovalRequest = z.strictObject({ note: z.string().trim().max(500).default('') });
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequest>;
export const DecideApprovalResponse = z.object({ approval: Approval });
export type DecideApprovalResponse = z.infer<typeof DecideApprovalResponse>;
export const approveApprovalRoute = { method: 'POST', path: '/api/teams/:slug/approvals/:approvalId/approve' } as const;
export const denyApprovalRoute = { method: 'POST', path: '/api/teams/:slug/approvals/:approvalId/deny' } as const;

/** The whole stored call, for the people who may decide the approval (403 for anyone else); a hand-back has none (`args` null). */
export const GetApprovalArgsResponse = z.object({ args: JsonObject.nullable() });
export type GetApprovalArgsResponse = z.infer<typeof GetApprovalArgsResponse>;
export const getApprovalArgsRoute = { method: 'GET', path: '/api/teams/:slug/approvals/:approvalId/args' } as const;

/** The approvals raised in one thread (newest last), whatever their status: the card in the thread view. */
export const ListThreadApprovalsPathParams = z.object({ rootId: MessageId });
export type ListThreadApprovalsPathParams = z.infer<typeof ListThreadApprovalsPathParams>;
export const ListThreadApprovalsResponse = z.object({ items: z.array(Approval) });
export type ListThreadApprovalsResponse = z.infer<typeof ListThreadApprovalsResponse>;
export const listThreadApprovalsRoute = { method: 'GET', path: '/api/threads/:rootId/approvals' } as const;

/** Live push to the people who may care: an approval was raised or settled in the team (a hint; the list is the truth). */
export const ApprovalChangedPush = z.object({ teamId: TeamId, approvalId: ApprovalId });
export type ApprovalChangedPush = z.infer<typeof ApprovalChangedPush>;
export const approvalChangedPushType = 'approval.changed' as const;
