import { PasswordCredential } from '@majlis/shared';

/** The `hash` column is deliberately absent: it is read only by the password plugin's verify query. */
export interface PasswordCredentialRow {
  person_id: string;
  must_change: boolean;
  created_at: Date;
  updated_at: Date;
}

export const toPasswordCredential = (row: PasswordCredentialRow): PasswordCredential =>
  PasswordCredential.parse({
    personId: row.person_id,
    mustChange: row.must_change,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
