import { EventRecord } from '@majlis/shared';

export interface EventRow {
  id: string;
  occurred_at: Date;
  workspace_id: string;
  team_id: string | null;
  actor_id: string;
  type: string;
  schema_version: number;
  payload: unknown;
}

export const toEventRecord = (row: EventRow): EventRecord =>
  EventRecord.parse({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    actorId: row.actor_id,
    type: row.type,
    schemaVersion: row.schema_version,
    payload: row.payload,
  });
