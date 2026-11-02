import { z } from 'zod';
import {
  Connection,
  ConnectionEnvironment,
  ConnectionId,
  ConnectionKind,
  ConnectionSecretName,
  ConnectionSlug,
  ConnectionStatus,
} from '../../entities/connection.ts';
import { IsoDateTime } from '../../common/time.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// The routes of connections (PLAN P8-01, P8-28, P8-06). Everyone who can read the team lists its connections; the answer never carries a credential, and no route
// takes one back out. A workspace admin adds, changes, switches on and removes a team's connections and puts credentials in; a person lists and removes their own.
// docs/plugins/connections.md.

export const ConnectionsTeamParams = z.object({ slug: TeamSlug });
export type ConnectionsTeamParams = z.infer<typeof ConnectionsTeamParams>;

export const ListConnectionsResponse = z.strictObject({
  connections: z.array(Connection),
});
export type ListConnectionsResponse = z.infer<typeof ListConnectionsResponse>;
export const listConnectionsRoute = { method: 'GET', path: '/api/teams/:slug/connections' } as const satisfies ApiRoute;

/** The signed-in person's own connections, across the workspace (the account page). */
export const listMyConnectionsRoute = { method: 'GET', path: '/api/me/connections' } as const satisfies ApiRoute;

/** The name a connection is shown under; the same limit as the table's check. */
export const ConnectionDisplayName = z.string().trim().min(1).max(80);

/**
 * Add a team's connection. It starts switched off with no credential: the next calls put the credential in and switch it on. `slug` is the short name a bot file
 * uses; left out, it is made from the name. `expiresAt` is when the credential stops working, if known.
 */
export const CreateConnectionRequest = z.strictObject({
  kind: ConnectionKind,
  name: ConnectionDisplayName,
  slug: ConnectionSlug.optional(),
  environment: ConnectionEnvironment.optional(),
  expiresAt: IsoDateTime.nullable().optional(),
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;
export const CreateConnectionResponse = z.strictObject({ connection: Connection });
export type CreateConnectionResponse = z.infer<typeof CreateConnectionResponse>;
export const createConnectionRoute = { method: 'POST', path: '/api/teams/:slug/connections' } as const satisfies ApiRoute;

export const ConnectionPathParams = z.object({ id: ConnectionId });
export type ConnectionPathParams = z.infer<typeof ConnectionPathParams>;

/** Change a connection. Its kind, short name and team never change. `status: 'enabled'` is refused until a credential is stored. */
export const UpdateConnectionRequest = z.strictObject({
  name: ConnectionDisplayName.optional(),
  status: ConnectionStatus.optional(),
  environment: ConnectionEnvironment.optional(),
  expiresAt: IsoDateTime.nullable().optional(),
});
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;
export const UpdateConnectionResponse = z.strictObject({ connection: Connection });
export type UpdateConnectionResponse = z.infer<typeof UpdateConnectionResponse>;
export const updateConnectionRoute = { method: 'PATCH', path: '/api/connections/:id' } as const satisfies ApiRoute;

export const ConnectionCredentialPathParams = z.object({ id: ConnectionId, name: ConnectionSecretName });
export type ConnectionCredentialPathParams = z.infer<typeof ConnectionCredentialPathParams>;

/** Put a credential in (or replace it). The value is sealed and never comes back out; the answer says only that the connection now holds one. */
export const PutConnectionCredentialRequest = z.strictObject({ value: z.string().min(1).max(16_384) });
export type PutConnectionCredentialRequest = z.infer<typeof PutConnectionCredentialRequest>;
export const PutConnectionCredentialResponse = z.strictObject({ connection: Connection });
export type PutConnectionCredentialResponse = z.infer<typeof PutConnectionCredentialResponse>;
export const putConnectionCredentialRoute = { method: 'PUT', path: '/api/connections/:id/credentials/:name' } as const satisfies ApiRoute;

export const DeleteConnectionResponse = z.strictObject({ deleted: z.literal(true) });
export type DeleteConnectionResponse = z.infer<typeof DeleteConnectionResponse>;
export const deleteConnectionRoute = { method: 'DELETE', path: '/api/connections/:id' } as const satisfies ApiRoute;

export * from './mail.ts';
export * from './person.ts';
