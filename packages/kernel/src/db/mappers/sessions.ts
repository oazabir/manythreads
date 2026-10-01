import { Session } from '@majlis/shared';

export interface SessionRow {
  id: string;
  workspace_id: string;
  person_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  device: string | null;
  revoked_at: Date | null;
}

export const toSession = (row: SessionRow): Session =>
  Session.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    personId: row.person_id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    device: row.device,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
