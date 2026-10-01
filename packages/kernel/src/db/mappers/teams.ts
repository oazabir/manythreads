import { Team } from '@manythreads/shared';

export interface TeamRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  template: string | null;
  template_definition: unknown;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const toTeam = (row: TeamRow): Team =>
  Team.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    template: row.template,
    templateDefinition: row.template_definition,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
