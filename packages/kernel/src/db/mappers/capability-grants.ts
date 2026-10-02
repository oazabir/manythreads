import { CapabilityGrant } from '@manythreads/shared';

export interface CapabilityGrantRow {
  id: string;
  team_id: string;
  actor_id: string;
  capability: string;
  needs_approval: boolean;
  constraints: unknown;
  created_at: Date;
}

export const toCapabilityGrant = (row: CapabilityGrantRow): CapabilityGrant =>
  CapabilityGrant.parse({
    id: row.id,
    teamId: row.team_id,
    actorId: row.actor_id,
    capability: row.capability,
    needsApproval: row.needs_approval,
    constraints: row.constraints,
    createdAt: row.created_at.toISOString(),
  });
