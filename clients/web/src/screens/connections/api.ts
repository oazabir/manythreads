import {
  CreateConnectionRequest,
  CreateConnectionResponse,
  DeleteConnectionResponse,
  ListConnectionsResponse,
  PutConnectionCredentialRequest,
  PutConnectionCredentialResponse,
  UpdateConnectionRequest,
  UpdateConnectionResponse,
  createConnectionRoute,
  deleteConnectionRoute,
  listConnectionsRoute,
  listMyConnectionsRoute,
  putConnectionCredentialRoute,
  updateConnectionRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Connections pages ask of the server (docs/plugins/connections.md). A team's connections are listed for every member of the team and written by a
 * workspace admin only. A credential goes in with its own call and is never read back: a connection says only whether one is stored (`hasCredentials`).
 */

export const fetchTeamConnections = (slug: string) => call(listConnectionsRoute, { response: ListConnectionsResponse }, undefined, { slug });

export const fetchMyConnections = () => call(listMyConnectionsRoute, { response: ListConnectionsResponse });

export const createConnection = (slug: string, body: CreateConnectionRequest) =>
  call(createConnectionRoute, { request: CreateConnectionRequest, response: CreateConnectionResponse }, body, { slug });

export const updateConnection = (id: string, body: UpdateConnectionRequest) =>
  call(updateConnectionRoute, { request: UpdateConnectionRequest, response: UpdateConnectionResponse }, body, { id });

/** Stores (or replaces) one credential, sealed. The answer carries the connection, not the value. */
export const putConnectionCredential = (id: string, name: string, value: string) =>
  call(putConnectionCredentialRoute, { request: PutConnectionCredentialRequest, response: PutConnectionCredentialResponse }, { value }, { id, name });

export const deleteConnection = (id: string) => call(deleteConnectionRoute, { response: DeleteConnectionResponse }, undefined, { id });
