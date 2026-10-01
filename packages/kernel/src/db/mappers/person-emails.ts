import { PersonEmail } from '@manythreads/shared';

export interface PersonEmailRow {
  id: string;
  workspace_id: string;
  person_id: string;
  email: string;
  verified_at: Date | null;
  created_at: Date;
}

export const toPersonEmail = (row: PersonEmailRow): PersonEmail =>
  PersonEmail.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    personId: row.person_id,
    email: row.email,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
