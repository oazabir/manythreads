import { TeamPendingFile } from '@majlis/shared';

export interface TeamPendingFileRow {
  team_id: string;
  files: unknown;
  applied_at: Date | null;
  created_at: Date;
}

export const toTeamPendingFile = (row: TeamPendingFileRow): TeamPendingFile =>
  TeamPendingFile.parse({
    teamId: row.team_id,
    files: row.files,
    appliedAt: row.applied_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
