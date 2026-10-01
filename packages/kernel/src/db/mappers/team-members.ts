import { TeamMember } from '@manythreads/shared';

export interface TeamMemberRow {
  team_id: string;
  actor_id: string;
  workspace_id: string;
  role: string;
  created_at: Date;
}

export const toTeamMember = (row: TeamMemberRow): TeamMember =>
  TeamMember.parse({
    teamId: row.team_id,
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  });
