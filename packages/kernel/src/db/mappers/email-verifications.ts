import { EmailVerification } from '@manythreads/shared';

/** The `token_hash` column is not mapped. */
export interface EmailVerificationRow {
  id: string;
  workspace_id: string;
  person_id: string;
  purpose: string;
  email: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export const toEmailVerification = (row: EmailVerificationRow): EmailVerification =>
  EmailVerification.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    personId: row.person_id,
    purpose: row.purpose,
    email: row.email,
    expiresAt: row.expires_at.toISOString(),
    usedAt: row.used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
