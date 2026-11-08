import {
  CreateProviderHookRequest,
  CreateProviderHookResponse,
  DeleteProviderHookResponse,
  GetRunOriginResponse,
  ListProviderHooksResponse,
  PutProviderSigningSecretRequest,
  PutProviderSigningSecretResponse,
  RotateProviderHookResponse,
  UpdateProviderHookRequest,
  UpdateProviderHookResponse,
  createProviderHookRoute,
  deleteProviderHookRoute,
  getRunOriginRoute,
  listProviderHooksRoute,
  putProviderSigningSecretRoute,
  rotateProviderHookRoute,
  updateProviderHookRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

/*
 * The addresses a work app calls (docs/plugins/webhooks.md "Bundle D contracts"). The signing secret is shown once, in the answer of the call that made it, and is never read back.
 */

export const fetchProviderHooks = (channelId: string) => call(listProviderHooksRoute, { response: ListProviderHooksResponse }, undefined, { channelId });
export const createProviderHook = (channelId: string, body: CreateProviderHookRequest) =>
  call(createProviderHookRoute, { request: CreateProviderHookRequest, response: CreateProviderHookResponse }, body, { channelId });
export const updateProviderHook = (endpointId: string, body: UpdateProviderHookRequest) =>
  call(updateProviderHookRoute, { request: UpdateProviderHookRequest, response: UpdateProviderHookResponse }, body, { endpointId });
export const deleteProviderHook = (endpointId: string) => call(deleteProviderHookRoute, { response: DeleteProviderHookResponse }, undefined, { endpointId });
export const putProviderSigningSecret = (endpointId: string, signingSecret: string) =>
  call(putProviderSigningSecretRoute, { request: PutProviderSigningSecretRequest, response: PutProviderSigningSecretResponse }, { signingSecret }, { endpointId });
export const rotateProviderHook = (endpointId: string) => call(rotateProviderHookRoute, { response: RotateProviderHookResponse }, undefined, { endpointId });
/** What started a run, for the card under a bot's post. A 404 means "nothing to show". */
export const fetchRunOrigin = (runId: string) => call(getRunOriginRoute, { response: GetRunOriginResponse }, undefined, { runId });
