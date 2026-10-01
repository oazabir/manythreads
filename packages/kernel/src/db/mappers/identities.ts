import { Identity } from '@majlis/shared';

export interface IdentityRow {
  id: string;
  workspace_id: string;
  person_id: string;
  provider_id: string;
  subject: string;
  created_at: Date;
}

export const toIdentity = (row: IdentityRow): Identity =>
  Identity.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    personId: row.person_id,
    providerId: row.provider_id,
    subject: row.subject,
    createdAt: row.created_at.toISOString(),
  });
