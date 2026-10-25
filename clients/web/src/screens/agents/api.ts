import {
  CreateHermesConnectionRequest,
  CreateHermesConnectionResponse,
  DeleteHermesConnectionResponse,
  ListHermesConnectionsResponse,
  TestHermesConnectionRequest,
  TestHermesConnectionResponse,
  UpdateHermesConnectionRequest,
  UpdateHermesConnectionResponse,
  createHermesConnectionRoute,
  deleteHermesConnectionRoute,
  listHermesConnectionsRoute,
  testHermesConnectionRoute,
  updateHermesConnectionRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/* What the Agents page asks of the server: a team's connections (list, add, change, remove, test). The API key is write-only. */

export const fetchConnections = (slug: string) => call(listHermesConnectionsRoute, { response: ListHermesConnectionsResponse }, undefined, { slug });

export const createConnection = (slug: string, body: CreateHermesConnectionRequest) =>
  call(createHermesConnectionRoute, { request: CreateHermesConnectionRequest, response: CreateHermesConnectionResponse }, body, { slug });

export const updateConnection = (slug: string, connectionId: string, body: UpdateHermesConnectionRequest) =>
  call(updateHermesConnectionRoute, { request: UpdateHermesConnectionRequest, response: UpdateHermesConnectionResponse }, body, { slug, connectionId });

export const deleteConnection = (slug: string, connectionId: string) =>
  call(deleteHermesConnectionRoute, { response: DeleteHermesConnectionResponse }, undefined, { slug, connectionId });

export const testConnection = (slug: string, connectionId: string) =>
  call(testHermesConnectionRoute, { request: TestHermesConnectionRequest, response: TestHermesConnectionResponse }, {}, { slug, connectionId });
