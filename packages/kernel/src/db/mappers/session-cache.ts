import { SessionCacheEntry } from '@majlis/shared';

export interface SessionCacheRow {
  token_hash: Buffer;
  session_id: string;
  expires_at: Date;
  created_at: Date;
}

export const toSessionCacheEntry = (row: SessionCacheRow): SessionCacheEntry =>
  SessionCacheEntry.parse({
    tokenHash: row.token_hash.toString('hex'),
    sessionId: row.session_id,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  });
