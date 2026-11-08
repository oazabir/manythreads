import {
  AdminDisconnectConnectionResponse,
  ListConnectionPeopleResponse,
  ListConnectorHealthResponse,
  ListMyCalendarsResponse,
  OffboardConnectionsRequest,
  OffboardConnectionsResponse,
  OffboardPreviewResponse,
  adminDisconnectConnectionRoute,
  bridgesHealthRoute,
  connectionsHealthRoute,
  connectorSourcesHealthRoute,
  listConnectionPeopleRoute,
  listMyCalendarsRoute,
  offboardConnectionsRoute,
  offboardPreviewRoute,
  providerEndpointsHealthRoute,
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

// ---- Bundle D: calendars, the admin's health and people, and offboarding (docs/plugins/connections.md "Bundle D contracts") -----------------------------------
/** The calendars the caller can plan a room in, from their own Google or Microsoft connection. */
export const fetchMyCalendars = () => call(listMyCalendarsRoute, { response: ListMyCalendarsResponse });
/** The admin's health rows, one list per plugin that has the data; the page merges them. */
export const fetchConnectionsHealth = () => call(connectionsHealthRoute, { response: ListConnectorHealthResponse });
export const fetchProviderEndpointsHealth = () => call(providerEndpointsHealthRoute, { response: ListConnectorHealthResponse });
export const fetchConnectorSourcesHealth = () => call(connectorSourcesHealthRoute, { response: ListConnectorHealthResponse });
export const fetchBridgesHealth = () => call(bridgesHealthRoute, { response: ListConnectorHealthResponse });
export const fetchConnectionPeople = () => call(listConnectionPeopleRoute, { response: ListConnectionPeopleResponse });
export const adminDisconnectConnection = (connectionId: string) =>
  call(adminDisconnectConnectionRoute, { response: AdminDisconnectConnectionResponse }, undefined, { connectionId });
export const fetchOffboardPreview = (personId: string) => call(offboardPreviewRoute, { response: OffboardPreviewResponse }, undefined, { personId });
export const offboardConnections = (personId: string) =>
  call(offboardConnectionsRoute, { request: OffboardConnectionsRequest, response: OffboardConnectionsResponse }, {}, { personId });
