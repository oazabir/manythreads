import { RoleMember } from '@manythreads/shared';

export interface RoleMemberRow {
  role_id: string;
  person_id: string;
  workspace_id: string;
  created_at: Date;
}

export const toRoleMember = (row: RoleMemberRow): RoleMember =>
  RoleMember.parse({
    roleId: row.role_id,
    personId: row.person_id,
    workspaceId: row.workspace_id,
    createdAt: row.created_at.toISOString(),
  });
