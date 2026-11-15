import {
  CreateBotServerRequest,
  CreateBotServerResponse,
  DeleteBotServerResponse,
  ListBotServersResponse,
  MintBotServerCodeResponse,
  RotateBotServerKeyResponse,
  createBotServerRoute,
  deleteBotServerRoute,
  listBotServersRoute,
  mintBotServerCodeRoute,
  rotateBotServerKeyRoute,
} from '@manythreads/shared';
import { call } from '../../../api/client';

/* What the servers part of the Runners page asks of the site (P26-13). Every route is for a workspace admin. A code is in the answer once; a key never is. */

export const fetchBotServers = () => call(listBotServersRoute, { response: ListBotServersResponse });

export const createBotServer = (body: CreateBotServerRequest) => call(createBotServerRoute, { request: CreateBotServerRequest, response: CreateBotServerResponse }, body);

/** A fresh code for a server that was made but never connected (or lost its key): the old code stops working. */
export const mintBotServerCode = (id: string) => call(mintBotServerCodeRoute, { response: MintBotServerCodeResponse }, undefined, { id });

export const rotateBotServerKey = (id: string) => call(rotateBotServerKeyRoute, { response: RotateBotServerKeyResponse }, undefined, { id });

export const deleteBotServer = (id: string) => call(deleteBotServerRoute, { response: DeleteBotServerResponse }, undefined, { id });
