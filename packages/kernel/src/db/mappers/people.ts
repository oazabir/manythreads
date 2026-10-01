import { Person } from '@majlis/shared';

export interface PersonRow {
  id: string;
  workspace_id: string;
  display_name: string;
  primary_email: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export const toPerson = (row: PersonRow): Person =>
  Person.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    primaryEmail: row.primary_email,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
