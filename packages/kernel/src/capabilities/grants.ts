import type { ActorId, TeamId } from '@majlis/shared';
import { CapabilityGrant } from '@majlis/shared';
import { toCapabilityGrant, type CapabilityGrantRow } from '../db/mappers/capability-grants.ts';
import { withSystem, type Tx } from '../db/with-actor.ts';
import type { CapabilityRegistry } from './registry.ts';

export interface GrantLookup {
  needsApproval: boolean;
  constraints: Record<string, unknown>;
}

/** Where the broker finds a bot's allowlist entry. */
export interface GrantSource {
  find(actorId: ActorId, capability: string): Promise<GrantLookup | undefined>;
}

/** Reads `app.capability_grants` as the system actor. */
export function createDbGrantSource(options: { pool?: import('pg').Pool } = {}): GrantSource {
  return {
    find: (actorId, capability) =>
      withSystem(
        async (tx) => {
          const res = await tx.query<CapabilityGrantRow & Record<string, unknown>>(
            'SELECT * FROM app.capability_grants WHERE actor_id = $1 AND capability = $2',
            [actorId, capability],
          );
          const row = res.rows[0];
          if (!row) return undefined;
          const grant = toCapabilityGrant(row);
          return { needsApproval: grant.needsApproval, constraints: grant.constraints };
        },
        options.pool ? { pool: options.pool } : {},
      ),
  };
}

export interface NewGrant {
  teamId: TeamId;
  actorId: ActorId;
  capability: string;
  needsApproval?: boolean;
  constraints?: Record<string, unknown>;
}

/**
 * Compile one allowlist entry into `app.capability_grants`. Rejects destructive and unknown capabilities
 * before touching the database. Needs a system-actor transaction (the table's write policies).
 */
export async function createGrant(tx: Tx, registry: CapabilityRegistry, grant: NewGrant): Promise<CapabilityGrant> {
  registry.assertGrantable([grant.capability]);
  const res = await tx.query<CapabilityGrantRow & Record<string, unknown>>(
    `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (actor_id, capability) DO UPDATE
       SET needs_approval = EXCLUDED.needs_approval, constraints = EXCLUDED.constraints
     RETURNING *`,
    [grant.teamId, grant.actorId, grant.capability, grant.needsApproval ?? false, JSON.stringify(grant.constraints ?? {})],
  );
  const row = res.rows[0];
  if (!row) throw new Error('capability grant insert returned no row');
  return toCapabilityGrant(row);
}
