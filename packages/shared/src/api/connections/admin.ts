import { z } from 'zod';
import { ConnectionPersonRow, ConnectorHealthRow } from '../../entities/connector-health.ts';
import type { ApiRoute } from '../client/route.ts';

// Usage, health and scopes of the connected apps for workspace admins (PLAN Bundle D, P16-11, plugin `connections`). Content-blind: counts, states and service names;
// never a token, an account address or what a call read. A person who is not an admin gets 403 (a team lead does not). docs/plugins/connections.md "Admin".

export const ListConnectorHealthResponse = z.object({ rows: z.array(ConnectorHealthRow).max(100) });
export type ListConnectorHealthResponse = z.infer<typeof ListConnectorHealthResponse>;
/** The connections plugin's own rows. The webhooks, knowledge and bridges plugins answer `/api/admin/webhooks/provider-health`, `/api/admin/knowledge/connector-health` and `/api/admin/bridges/health` with the same shape. */
export const connectionsHealthRoute = { method: 'GET', path: '/api/admin/connections/health' } as const satisfies ApiRoute;
export const providerEndpointsHealthRoute = { method: 'GET', path: '/api/admin/webhooks/provider-health' } as const satisfies ApiRoute;
export const connectorSourcesHealthRoute = { method: 'GET', path: '/api/admin/knowledge/connector-health' } as const satisfies ApiRoute;
export const bridgesHealthRoute = { method: 'GET', path: '/api/admin/bridges/health' } as const satisfies ApiRoute;

export const ListConnectionPeopleResponse = z.object({ people: z.array(ConnectionPersonRow).max(2000) });
export type ListConnectionPeopleResponse = z.infer<typeof ListConnectionPeopleResponse>;
export const listConnectionPeopleRoute = { method: 'GET', path: '/api/admin/connections/people' } as const satisfies ApiRoute;

export const AdminConnectionParams = z.object({ connectionId: z.uuid() });
export type AdminConnectionParams = z.infer<typeof AdminConnectionParams>;
/** Remove one person's grant: the provider is asked to forget it where it can be, and the sealed tokens are deleted. */
export const AdminDisconnectConnectionResponse = z.object({ removed: z.literal(true), providerRevoked: z.boolean() });
export type AdminDisconnectConnectionResponse = z.infer<typeof AdminDisconnectConnectionResponse>;
export const adminDisconnectConnectionRoute = { method: 'DELETE', path: '/api/admin/connections/people/:connectionId' } as const satisfies ApiRoute;
