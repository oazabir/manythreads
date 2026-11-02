import {
  AdoptConnectionRequest,
  AdoptConnectionResponse,
  CreateBotRunnerRequest,
  CreateBotRunnerResponse,
  DeleteBotRunnerResponse,
  ListBotRunnersResponse,
  ListOldConnectionsResponse,
  ListRunnerNodesQuery,
  ListRunnerNodesResponse,
  SetBotRunnerTeamsRequest,
  SetBotRunnerTeamsResponse,
  SetDefaultBotRunnerRequest,
  SetDefaultBotRunnerResponse,
  SetRunnerNodeRequest,
  SetRunnerNodeResponse,
  TestBotRunnerRequest,
  TestBotRunnerResponse,
  UpdateBotRunnerRequest,
  UpdateBotRunnerResponse,
  adoptConnectionRoute,
  createBotRunnerRoute,
  deleteBotRunnerRoute,
  listBotRunnersRoute,
  listOldConnectionsRoute,
  listRunnerNodesRoute,
  setBotRunnerTeamsRoute,
  setDefaultBotRunnerRoute,
  setRunnerNodeRoute,
  testBotRunnerRoute,
  updateBotRunnerRoute,
} from '@manythreads/shared';
import { call } from '../../../api/client';

/*
 * What the Runners page asks of the server (docs/plugins/bot-runners.md). Every route is for a workspace admin. A gateway key goes in on `create` or
 * `update` and is never read back: the list says only whether one is set (`hasKey`).
 */

export const fetchBotRunners = () => call(listBotRunnersRoute, { response: ListBotRunnersResponse });

export const createBotRunner = (body: CreateBotRunnerRequest) =>
  call(createBotRunnerRoute, { request: CreateBotRunnerRequest, response: CreateBotRunnerResponse }, body);

export const updateBotRunner = (id: string, body: UpdateBotRunnerRequest) =>
  call(updateBotRunnerRoute, { request: UpdateBotRunnerRequest, response: UpdateBotRunnerResponse }, body, { id });

export const deleteBotRunner = (id: string) => call(deleteBotRunnerRoute, { response: DeleteBotRunnerResponse }, undefined, { id });

/** Ask the runner whether it answers; `profile` names the Hermes profile to ask for (left out: the gateway's default one). */
export const testBotRunner = (id: string, body: TestBotRunnerRequest = {}) =>
  call(testBotRunnerRoute, { request: TestBotRunnerRequest, response: TestBotRunnerResponse }, body, { id });

export const setBotRunnerTeams = (id: string, body: SetBotRunnerTeamsRequest) =>
  call(setBotRunnerTeamsRoute, { request: SetBotRunnerTeamsRequest, response: SetBotRunnerTeamsResponse }, body, { id });

/** `null` clears the default. */
export const setDefaultBotRunner = (runnerId: string | null) =>
  call(setDefaultBotRunnerRoute, { request: SetDefaultBotRunnerRequest, response: SetDefaultBotRunnerResponse }, { runnerId });

export const fetchOldConnections = () => call(listOldConnectionsRoute, { response: ListOldConnectionsResponse });

/** The machines the operator allows for pod runners; with `runnerId`, also where that runner's work volume is and where its pods stand. */
export const fetchRunnerNodes = (runnerId?: string) =>
  call(listRunnerNodesRoute, { request: ListRunnerNodesQuery, response: ListRunnerNodesResponse }, runnerId ? ({ runnerId } as ListRunnerNodesQuery) : {});

/** `null` lets the cluster choose. A new machine recreates the pods' work volumes empty on it (the page asks first). */
export const setRunnerNode = (id: string, node: string | null) =>
  call(setRunnerNodeRoute, { request: SetRunnerNodeRequest, response: SetRunnerNodeResponse }, { node }, { id });

export const adoptOldConnection = (connectionId: string, body: AdoptConnectionRequest = {}) =>
  call(adoptConnectionRoute, { request: AdoptConnectionRequest, response: AdoptConnectionResponse }, body, { connectionId });
