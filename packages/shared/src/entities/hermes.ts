import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, HermesConnectionId, TeamId, WorkspaceId } from '../ids.ts';

// Hermes connections (a team's way to reach a Hermes gateway over HTTP). Every enum matches a CHECK of the runtime-hermes migration
// 0001_connections.sql; the kernel's schema-enums test compares the two.

/** `external` is a gateway the customer runs (they own its profiles, models and tools); `managed` is the team's own Hermes pod in the cluster. */
export const HermesConnectionKind = z.enum(['external', 'managed']);
export type HermesConnectionKind = z.infer<typeof HermesConnectionKind>;

/** What the last check found: `unknown` before the first one. */
export const HermesConnectionStatus = z.enum(['unknown', 'ok', 'error']);
export type HermesConnectionStatus = z.infer<typeof HermesConnectionStatus>;

/** A connection's name: the slug a BOT.md `placement.gateway.connection` uses. `managed` is the reserved name of the team's own pod. */
export const HermesConnectionName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'lowercase letters, digits, ".", "_" or "-"');
export type HermesConnectionName = z.infer<typeof HermesConnectionName>;

/** The reserved connection name of mode B (the team's own Hermes pod). */
export const MANAGED_CONNECTION_NAME = 'managed';

/** The API key is write-only: a connection says whether it has one, never what it is. */
export const HermesConnection = z.object({
  id: HermesConnectionId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  name: HermesConnectionName,
  kind: HermesConnectionKind,
  baseUrl: z.string().nullable(),
  hasApiKey: z.boolean(),
  status: HermesConnectionStatus,
  lastCheckedAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  createdBy: ActorId.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HermesConnection = z.infer<typeof HermesConnection>;
