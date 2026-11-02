import {
  AdoptConnectionRequest,
  AdoptConnectionResponse,
  CreateBotRunnerRequest,
  CreateBotRunnerResponse,
  DeleteBotRunnerResponse,
  ListBotRunnersResponse,
  ListOldConnectionsResponse,
  SetBotRunnerTeamsRequest,
  SetBotRunnerTeamsResponse,
  SetDefaultBotRunnerRequest,
  SetDefaultBotRunnerResponse,
  TestBotRunnerRequest,
  TestBotRunnerResponse,
  UpdateBotRunnerRequest,
  UpdateBotRunnerResponse,
  adoptConnectionRoute,
  createBotRunnerRoute,
  deleteBotRunnerRoute,
  listBotRunnersRoute,
  listOldConnectionsRoute,
  setBotRunnerTeamsRoute,
  setDefaultBotRunnerRoute,
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

export const adoptOldConnection = (connectionId: string, body: AdoptConnectionRequest = {}) =>
  call(adoptConnectionRoute, { request: AdoptConnectionRequest, response: AdoptConnectionResponse }, body, { connectionId });
