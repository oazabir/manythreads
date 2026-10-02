import { WorkspaceMember } from '@manythreads/shared';

export interface WorkspaceMemberRow {
  workspace_id: string;
  person_id: string;
  role: string;
  created_at: Date;
}

export const toWorkspaceMember = (row: WorkspaceMemberRow): WorkspaceMember =>
  WorkspaceMember.parse({
    workspaceId: row.workspace_id,
    personId: row.person_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  });
