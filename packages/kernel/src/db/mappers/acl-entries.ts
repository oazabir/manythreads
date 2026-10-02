import { AclEntry } from '@manythreads/shared';

export interface AclEntryRow {
  id: string;
  workspace_id: string;
  resource_type: string;
  resource_id: string;
  subject_type: string;
  subject_id: string;
  permission: string;
  created_at: Date;
}

export const toAclEntry = (row: AclEntryRow): AclEntry =>
  AclEntry.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    permission: row.permission,
    createdAt: row.created_at.toISOString(),
  });
