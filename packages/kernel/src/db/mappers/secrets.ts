import { Secret } from '@majlis/shared';

/** Only the metadata columns; `ciphertext` and `wrapped_key` have no shared type and are read by getSecret alone. */
export interface SecretRow {
  id: string;
  key_id: string;
  created_at: Date;
}

export const toSecret = (row: SecretRow): Secret =>
  Secret.parse({ id: row.id, keyId: row.key_id, createdAt: row.created_at.toISOString() });
