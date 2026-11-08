import {
  BridgeAccountResponse,
  ChannelLinkCodeResponse,
  DeleteBridgeAccountResponse,
  DeleteBridgeLinkResponse,
  LinkCodeResponse,
  ListBridgeAccountsResponse,
  ListChannelBridgesResponse,
  ListMyBridgesResponse,
  PutBridgeAccountRequest,
  PutBridgeCredentialsRequest,
  SwitchBridgeRequest,
  UnlinkMyBridgeResponse,
  createChannelBridgeCodeRoute,
  createMyBridgeLinkCodeRoute,
  deleteBridgeAccountRoute,
  deleteBridgeLinkRoute,
  listBridgeAccountsRoute,
  listChannelBridgesRoute,
  listMyBridgesRoute,
  putBridgeAccountRoute,
  putBridgeCredentialsRoute,
  switchBridgeRoute,
  unlinkMyBridgeRoute,
  type BridgeProvider,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the chat-app pages ask of the server (docs/plugins/bridges.md). An admin sets up one account per service and puts credentials in (they are sealed and never read back); a person links their
 * own chat user with a code; a lead joins a public channel to an outside chat with another. Only linked people are ever heard.
 */

export const fetchBridgeAccounts = () => call(listBridgeAccountsRoute, { response: ListBridgeAccountsResponse });
export const saveBridgeAccount = (provider: BridgeProvider, body: PutBridgeAccountRequest) =>
  call(putBridgeAccountRoute, { request: PutBridgeAccountRequest, response: BridgeAccountResponse }, body, { provider });
export const saveBridgeCredentials = (provider: BridgeProvider, body: PutBridgeCredentialsRequest) =>
  call(putBridgeCredentialsRoute, { request: PutBridgeCredentialsRequest, response: BridgeAccountResponse }, body, { provider });
export const switchBridge = (provider: BridgeProvider, on: boolean) =>
  call(switchBridgeRoute, { request: SwitchBridgeRequest, response: BridgeAccountResponse }, { on }, { provider });
export const deleteBridgeAccount = (provider: BridgeProvider) => call(deleteBridgeAccountRoute, { response: DeleteBridgeAccountResponse }, undefined, { provider });

export const fetchMyBridges = () => call(listMyBridgesRoute, { response: ListMyBridgesResponse });
export const createMyLinkCode = (provider: BridgeProvider) => call(createMyBridgeLinkCodeRoute, { response: LinkCodeResponse }, undefined, { provider });
export const unlinkMyBridge = (provider: BridgeProvider) => call(unlinkMyBridgeRoute, { response: UnlinkMyBridgeResponse }, undefined, { provider });

export const fetchChannelBridges = (channelId: string) => call(listChannelBridgesRoute, { response: ListChannelBridgesResponse }, undefined, { channelId });
export const createChannelLinkCode = (channelId: string, provider: BridgeProvider) =>
  call(createChannelBridgeCodeRoute, { response: ChannelLinkCodeResponse }, undefined, { channelId, provider });
export const deleteBridgeLink = (linkId: string) => call(deleteBridgeLinkRoute, { response: DeleteBridgeLinkResponse }, undefined, { linkId });
