import { Proposal } from '@manythreads/shared';

// Reading proposal rows: the one mapper for app.proposals. `content` (the proposed text) is read where it is needed and never mapped to the API shape.

export interface ProposalRow {
  id: string;
  workspace_id: string;
  team_id: string;
  author_id: string;
  author_kind: 'person' | 'bot';
  author_name: string;
  title: string;
  note: string;
  path: string;
  op: 'put' | 'delete';
  content: string | null;
  base_blob_sha: string | null;
  base_commit_sha: string;
  needs_admin: boolean;
  diff: string;
  added: number;
  removed: number;
  checks: unknown;
  status: 'open' | 'applied' | 'rejected' | 'withdrawn';
  self_applied: boolean;
  created_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
  decision_note: string | null;
  applied_commit_sha: string | null;
  [key: string]: unknown;
}

export const PROPOSAL_COLUMNS =
  'p.id, p.workspace_id, p.team_id, p.author_id, p.author_kind, p.author_name, p.title, p.note, p.path, p.op, p.content, p.base_blob_sha, p.base_commit_sha, p.needs_admin, p.diff, p.added, p.removed, p.checks, p.status, p.self_applied, p.created_at, p.decided_at, p.decided_by_name, p.decision_note, p.applied_commit_sha';

export const toProposal = (r: ProposalRow): Proposal =>
  Proposal.parse({
    id: r.id,
    teamId: r.team_id,
    path: r.path,
    op: r.op,
    title: r.title,
    note: r.note,
    status: r.status,
    authorId: r.author_id,
    authorKind: r.author_kind,
    authorName: r.author_name,
    baseBlobSha: r.base_blob_sha,
    baseCommitSha: r.base_commit_sha,
    diff: r.diff,
    added: r.added,
    removed: r.removed,
    checks: r.checks,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decidedByName: r.decided_by_name,
    decisionNote: r.decision_note,
    appliedCommitSha: r.applied_commit_sha,
    selfApplied: r.self_applied,
  });
