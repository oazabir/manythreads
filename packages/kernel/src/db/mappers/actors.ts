import { Actor } from '@majlis/shared';

export interface ActorRow {
  id: string;
  kind: string;
  workspace_id: string;
  ref_id: string;
  created_at: Date;
}

export const toActor = (row: ActorRow): Actor =>
  Actor.parse({
    id: row.id,
    kind: row.kind,
    workspaceId: row.workspace_id,
    refId: row.ref_id,
    createdAt: row.created_at.toISOString(),
  });
