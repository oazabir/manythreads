import { Role } from '@manythreads/shared';

export interface RoleRow {
  id: string;
  workspace_id: string;
  name: string;
  created_at: Date;
}

export const toRole = (row: RoleRow): Role =>
  Role.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
  });
