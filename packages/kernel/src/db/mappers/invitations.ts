import { Invitation } from '@manythreads/shared';

/** The `token_hash` column is not mapped: the accept flow looks it up with its own query. */
export interface InvitationRow {
  id: string;
  workspace_id: string;
  team_id: string | null;
  email: string;
  role: string;
  grant_spec: unknown;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

export const toInvitation = (row: InvitationRow): Invitation =>
  Invitation.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    email: row.email,
    role: row.role,
    grant: row.grant_spec,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
