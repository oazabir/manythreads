import { Workspace } from '@majlis/shared';

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  self_signup: boolean;
  settings: unknown;
  created_at: Date;
  updated_at: Date;
}

export const toWorkspace = (row: WorkspaceRow): Workspace =>
  Workspace.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    selfSignup: row.self_signup,
    settings: row.settings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
